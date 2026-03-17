import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { SmimeKeyRecord, SmimePublicCert } from '@/lib/smime/types';
import {
  saveKeyRecord,
  listKeyRecords,
  deleteKeyRecord as deleteKeyRecordDB,
  savePublicCert,
  listPublicCerts,
  deletePublicCert as deletePublicCertDB,
} from '@/lib/smime/key-storage';
import { importPkcs12, unlockPrivateKey } from '@/lib/smime/pkcs12-import';
import {
  parseCertificatePemOrDer,
  extractCertificateInfo,
} from '@/lib/smime/certificate-utils';

const REMEMBERED_UNLOCKS_STORAGE_KEY = 'smime-unlocked-session';

type RememberedUnlocks = Record<string, string>;

function readRememberedUnlocks(): RememberedUnlocks {
  if (typeof window === 'undefined') {
    return {};
  }

  try {
    const raw = window.sessionStorage.getItem(REMEMBERED_UNLOCKS_STORAGE_KEY);
    if (!raw) {
      return {};
    }

    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {};
    }

    const rememberedUnlocks: RememberedUnlocks = {};
    for (const [keyId, passphrase] of Object.entries(parsed)) {
      if (typeof passphrase === 'string') {
        rememberedUnlocks[keyId] = passphrase;
      }
    }

    return rememberedUnlocks;
  } catch {
    return {};
  }
}

function writeRememberedUnlocks(rememberedUnlocks: RememberedUnlocks): void {
  if (typeof window === 'undefined') {
    return;
  }

  try {
    if (Object.keys(rememberedUnlocks).length === 0) {
      window.sessionStorage.removeItem(REMEMBERED_UNLOCKS_STORAGE_KEY);
      return;
    }

    window.sessionStorage.setItem(
      REMEMBERED_UNLOCKS_STORAGE_KEY,
      JSON.stringify(rememberedUnlocks),
    );
  } catch {
    // Ignore unavailable or blocked session storage.
  }
}

function rememberUnlockedKey(keyId: string, passphrase: string): void {
  const rememberedUnlocks = readRememberedUnlocks();
  rememberedUnlocks[keyId] = passphrase;
  writeRememberedUnlocks(rememberedUnlocks);
}

function forgetUnlockedKey(keyId: string): void {
  const rememberedUnlocks = readRememberedUnlocks();
  if (!(keyId in rememberedUnlocks)) {
    return;
  }

  delete rememberedUnlocks[keyId];
  writeRememberedUnlocks(rememberedUnlocks);
}

function clearRememberedUnlocks(): void {
  writeRememberedUnlocks({});
}

async function restoreRememberedKeys(keyRecords: SmimeKeyRecord[]): Promise<{
  unlockedKeys: Map<string, CryptoKey>;
  unlockedDecryptionKeys: Map<string, CryptoKey>;
}> {
  const rememberedUnlocks = readRememberedUnlocks();
  const unlockedKeys = new Map<string, CryptoKey>();
  const unlockedDecryptionKeys = new Map<string, CryptoKey>();
  let removedStaleEntries = false;

  for (const record of keyRecords) {
    const passphrase = rememberedUnlocks[record.id];
    if (!passphrase) {
      continue;
    }

    try {
      const { signingKey, decryptionKey } = await unlockPrivateKey(record, passphrase);
      unlockedKeys.set(record.id, signingKey);
      if (decryptionKey) {
        unlockedDecryptionKeys.set(record.id, decryptionKey);
      }
    } catch {
      delete rememberedUnlocks[record.id];
      removedStaleEntries = true;
    }
  }

  if (removedStaleEntries) {
    writeRememberedUnlocks(rememberedUnlocks);
  }

  return { unlockedKeys, unlockedDecryptionKeys };
}

interface SmimePersistedState {
  identityKeyBindings: Record<string, string>; // identityId → keyRecordId
  defaultSignIdentity: Record<string, boolean>; // identityId → sign by default
  defaultEncrypt: boolean;
  rememberUnlockedKeys: boolean;
  autoImportSignerCerts: boolean;
}

interface SmimeStore extends SmimePersistedState {
  // Loaded from IndexedDB
  keyRecords: SmimeKeyRecord[];
  publicCerts: SmimePublicCert[];
  // Runtime only — never persisted
  unlockedKeys: Map<string, CryptoKey>;
  unlockedDecryptionKeys: Map<string, CryptoKey>;
  isLoading: boolean;
  error: string | null;

  // Actions
  load: () => Promise<void>;
  importPKCS12: (file: ArrayBuffer, p12Passphrase: string, storagePassphrase: string) => Promise<SmimeKeyRecord>;
  importPublicCert: (data: ArrayBuffer | string, source: SmimePublicCert['source'], contactId?: string) => Promise<SmimePublicCert>;
  bindIdentityToKey: (identityId: string, keyRecordId: string | null) => void;
  removeKeyRecord: (id: string) => Promise<void>;
  removePublicCert: (id: string) => Promise<void>;
  unlockKey: (id: string, passphrase: string) => Promise<void>;
  lockKey: (id: string) => void;
  lockAllKeys: () => void;
  getKeyRecordForIdentity: (identityId: string) => SmimeKeyRecord | undefined;
  getPublicCertForEmail: (email: string) => SmimePublicCert | undefined;
  getRecipientCerts: (emails: string[]) => { found: SmimePublicCert[]; missing: string[] };
  setSignDefault: (identityId: string, value: boolean) => void;
  setEncryptDefault: (value: boolean) => void;
  setRememberUnlockedKeys: (value: boolean) => void;
  setAutoImportSignerCerts: (value: boolean) => void;
  isKeyUnlocked: (id: string) => boolean;
  getUnlockedKey: (id: string) => CryptoKey | undefined;
  setError: (error: string | null) => void;
}

export const useSmimeStore = create<SmimeStore>()(
  persist(
    (set, get) => ({
      // Persisted preferences
      identityKeyBindings: {},
      defaultSignIdentity: {},
      defaultEncrypt: false,
      rememberUnlockedKeys: false,
      autoImportSignerCerts: false,

      // Runtime state
      keyRecords: [],
      publicCerts: [],
      unlockedKeys: new Map(),
      unlockedDecryptionKeys: new Map(),
      isLoading: false,
      error: null,

      load: async () => {
        set({ isLoading: true, error: null });
        try {
          const [keyRecords, publicCerts] = await Promise.all([
            listKeyRecords(),
            listPublicCerts(),
          ]);

          if (get().rememberUnlockedKeys) {
            const restoredKeys = await restoreRememberedKeys(keyRecords);
            set((state) => ({
              keyRecords,
              publicCerts,
              unlockedKeys: new Map([
                ...state.unlockedKeys,
                ...restoredKeys.unlockedKeys,
              ]),
              unlockedDecryptionKeys: new Map([
                ...state.unlockedDecryptionKeys,
                ...restoredKeys.unlockedDecryptionKeys,
              ]),
              isLoading: false,
            }));
            return;
          }

          set({ keyRecords, publicCerts, isLoading: false });
        } catch (err) {
          set({
            error: err instanceof Error ? err.message : 'Failed to load S/MIME data',
            isLoading: false,
          });
        }
      },

      importPKCS12: async (file, p12Passphrase, storagePassphrase) => {
        set({ isLoading: true, error: null });
        try {
          const { keyRecord } = await importPkcs12(file, p12Passphrase, storagePassphrase);
          await saveKeyRecord(keyRecord);
          set((state) => ({
            keyRecords: [...state.keyRecords, keyRecord],
            isLoading: false,
          }));
          return keyRecord;
        } catch (err) {
          set({
            error: err instanceof Error ? err.message : 'Failed to import PKCS#12',
            isLoading: false,
          });
          throw err;
        }
      },

      importPublicCert: async (data, source, contactId) => {
        set({ isLoading: true, error: null });
        try {
          const cert = parseCertificatePemOrDer(data);
          // Always re-encode to DER — input might be PEM text (string or ArrayBuffer)
          const der = cert.toSchema(true).toBER(false);
          const info = await extractCertificateInfo(cert, der);
          const email = info.emailAddresses[0] ?? '';

          const publicCert: SmimePublicCert = {
            id: crypto.randomUUID(),
            email: email.toLowerCase(),
            certificate: der,
            issuer: info.issuer,
            subject: info.subject,
            notBefore: info.notBefore,
            notAfter: info.notAfter,
            fingerprint: info.fingerprint,
            source,
            contactId,
          };

          await savePublicCert(publicCert);
          set((state) => ({
            publicCerts: [...state.publicCerts, publicCert],
            isLoading: false,
          }));
          return publicCert;
        } catch (err) {
          set({
            error: err instanceof Error ? err.message : 'Failed to import certificate',
            isLoading: false,
          });
          throw err;
        }
      },

      bindIdentityToKey: (identityId, keyRecordId) => {
        set((state) => {
          const bindings = { ...state.identityKeyBindings };
          if (keyRecordId === null) {
            delete bindings[identityId];
          } else {
            bindings[identityId] = keyRecordId;
          }
          return { identityKeyBindings: bindings };
        });
      },

      removeKeyRecord: async (id) => {
        await deleteKeyRecordDB(id);
        forgetUnlockedKey(id);
        set((state) => {
          const unlockedKeys = new Map(state.unlockedKeys);
          unlockedKeys.delete(id);
          const unlockedDecryptionKeys = new Map(state.unlockedDecryptionKeys);
          unlockedDecryptionKeys.delete(id);
          // Remove any identity bindings pointing to this key
          const bindings = { ...state.identityKeyBindings };
          for (const [identityId, keyId] of Object.entries(bindings)) {
            if (keyId === id) delete bindings[identityId];
          }
          return {
            keyRecords: state.keyRecords.filter((k) => k.id !== id),
            unlockedKeys,
            unlockedDecryptionKeys,
            identityKeyBindings: bindings,
          };
        });
      },

      removePublicCert: async (id) => {
        await deletePublicCertDB(id);
        set((state) => ({
          publicCerts: state.publicCerts.filter((c) => c.id !== id),
        }));
      },

      unlockKey: async (id, passphrase) => {
        const record = get().keyRecords.find((k) => k.id === id);
        if (!record) throw new Error('Key record not found');

        const { signingKey, decryptionKey } = await unlockPrivateKey(record, passphrase);
        if (get().rememberUnlockedKeys) {
          rememberUnlockedKey(id, passphrase);
        }
        set((state) => {
          const unlockedKeys = new Map(state.unlockedKeys);
          unlockedKeys.set(id, signingKey);
          const unlockedDecryptionKeys = new Map(state.unlockedDecryptionKeys);
          if (decryptionKey) {
            unlockedDecryptionKeys.set(id, decryptionKey);
          }
          return { unlockedKeys, unlockedDecryptionKeys };
        });
      },

      lockKey: (id) => {
        forgetUnlockedKey(id);
        set((state) => {
          const unlockedKeys = new Map(state.unlockedKeys);
          unlockedKeys.delete(id);
          const unlockedDecryptionKeys = new Map(state.unlockedDecryptionKeys);
          unlockedDecryptionKeys.delete(id);
          return { unlockedKeys, unlockedDecryptionKeys };
        });
      },

      lockAllKeys: () => {
        clearRememberedUnlocks();
        set({ unlockedKeys: new Map(), unlockedDecryptionKeys: new Map() });
      },

      getKeyRecordForIdentity: (identityId) => {
        const { identityKeyBindings, keyRecords } = get();
        const keyId = identityKeyBindings[identityId];
        if (!keyId) return undefined;
        return keyRecords.find((k) => k.id === keyId);
      },

      getPublicCertForEmail: (email) => {
        return get().publicCerts.find(
          (c) => c.email.toLowerCase() === email.toLowerCase(),
        );
      },

      getRecipientCerts: (emails) => {
        const { publicCerts } = get();
        const found: SmimePublicCert[] = [];
        const missing: string[] = [];
        for (const email of emails) {
          const cert = publicCerts.find(
            (c) => c.email.toLowerCase() === email.toLowerCase(),
          );
          if (cert) {
            found.push(cert);
          } else {
            missing.push(email);
          }
        }
        return { found, missing };
      },

      setSignDefault: (identityId, value) => {
        set((state) => ({
          defaultSignIdentity: { ...state.defaultSignIdentity, [identityId]: value },
        }));
      },

      setEncryptDefault: (value) => {
        set({ defaultEncrypt: value });
      },

      setRememberUnlockedKeys: (value) => {
        set({ rememberUnlockedKeys: value });
        if (!value) {
          clearRememberedUnlocks();
          set({ unlockedKeys: new Map(), unlockedDecryptionKeys: new Map() });
        }
      },

      setAutoImportSignerCerts: (value) => {
        set({ autoImportSignerCerts: value });
      },

      isKeyUnlocked: (id) => get().unlockedKeys.has(id),

      getUnlockedKey: (id) => get().unlockedKeys.get(id),

      setError: (error) => set({ error }),
    }),
    {
      name: 'smime-preferences',
      partialize: (state): SmimePersistedState => ({
        identityKeyBindings: state.identityKeyBindings,
        defaultSignIdentity: state.defaultSignIdentity,
        defaultEncrypt: state.defaultEncrypt,
        rememberUnlockedKeys: state.rememberUnlockedKeys,
        autoImportSignerCerts: state.autoImportSignerCerts,
      }),
    },
  ),
);
