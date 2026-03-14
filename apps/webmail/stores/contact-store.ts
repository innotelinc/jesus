import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { ContactCard, AddressBook, ContactName } from '@/lib/jmap/types';
import type { JMAPClient } from '@/lib/jmap/client';

export function getContactDisplayName(contact: ContactCard): string {
  if (contact.name?.components) {
    const given = contact.name.components.find(c => c.kind === 'given')?.value || '';
    const surname = contact.name.components.find(c => c.kind === 'surname')?.value || '';
    const full = [given, surname].filter(Boolean).join(' ');
    if (full) return full;
  }
  if (contact.nicknames) {
    const nick = Object.values(contact.nicknames)[0];
    if (nick?.name) return nick.name;
  }
  if (contact.emails) {
    const email = Object.values(contact.emails)[0];
    if (email?.address) return email.address;
  }
  return '';
}

export function getContactPrimaryEmail(contact: ContactCard): string {
  if (!contact.emails) return '';
  return Object.values(contact.emails)[0]?.address || '';
}

export function getContactPhotoUri(contact: ContactCard): string | undefined {
  if (!contact.media) return undefined;
  for (const media of Object.values(contact.media)) {
    if (media.kind === 'photo' && media.uri) return media.uri;
  }
  return undefined;
}

interface ContactStore {
  contacts: ContactCard[];
  addressBooks: AddressBook[];
  selectedContactId: string | null;
  searchQuery: string;
  isLoading: boolean;
  error: string | null;
  supportsSync: boolean;

  selectedContactIds: Set<string>;
  activeTab: 'all' | 'groups';

  fetchContacts: (client: JMAPClient) => Promise<void>;
  fetchAddressBooks: (client: JMAPClient) => Promise<void>;
  createContact: (client: JMAPClient, contact: Partial<ContactCard>) => Promise<void>;
  updateContact: (client: JMAPClient, id: string, updates: Partial<ContactCard>) => Promise<void>;
  deleteContact: (client: JMAPClient, id: string) => Promise<void>;

  addLocalContact: (contact: ContactCard) => void;
  updateLocalContact: (id: string, updates: Partial<ContactCard>) => void;
  deleteLocalContact: (id: string) => void;

  setSelectedContact: (id: string | null) => void;
  setSearchQuery: (query: string) => void;
  setSupportsSync: (supports: boolean) => void;
  setActiveTab: (tab: 'all' | 'groups') => void;
  clearContacts: () => void;

  getAutocomplete: (query: string) => Array<{ name: string; email: string }>;

  getGroups: () => ContactCard[];
  getIndividuals: () => ContactCard[];
  getGroupMembers: (groupId: string) => ContactCard[];
  createGroup: (client: JMAPClient | null, name: string, memberIds: string[]) => Promise<void>;
  updateGroup: (client: JMAPClient | null, groupId: string, name: string) => Promise<void>;
  addMembersToGroup: (client: JMAPClient | null, groupId: string, memberIds: string[]) => Promise<void>;
  removeMembersFromGroup: (client: JMAPClient | null, groupId: string, memberIds: string[]) => Promise<void>;
  deleteGroup: (client: JMAPClient | null, groupId: string) => Promise<void>;

  toggleContactSelection: (id: string) => void;
  selectAllContacts: (ids: string[]) => void;
  clearSelection: () => void;
  bulkDeleteContacts: (client: JMAPClient | null, ids: string[]) => Promise<void>;
  bulkAddToGroup: (client: JMAPClient | null, groupId: string, contactIds: string[]) => Promise<void>;

  importContacts: (client: JMAPClient | null, contacts: ContactCard[]) => Promise<number>;
}

export const useContactStore = create<ContactStore>()(
  persist(
    (set, get) => ({
      contacts: [],
      addressBooks: [],
      selectedContactId: null,
      searchQuery: '',
      isLoading: false,
      error: null,
      supportsSync: false,
      selectedContactIds: new Set<string>(),
      activeTab: 'all' as const,

      fetchContacts: async (client) => {
        set({ isLoading: true, error: null });
        try {
          const contacts = await client.getContacts();
          set({ contacts, isLoading: false });
        } catch (error) {
          console.error('Failed to fetch contacts:', error);
          set({ error: 'Failed to fetch contacts', isLoading: false });
        }
      },

      fetchAddressBooks: async (client) => {
        try {
          const addressBooks = await client.getAddressBooks();
          set({ addressBooks });
        } catch (error) {
          console.error('Failed to fetch address books:', error);
          set({ error: 'Failed to fetch address books' });
        }
      },

      createContact: async (client, contact) => {
        set({ isLoading: true, error: null });
        try {
          const created = await client.createContact(contact);
          set((state) => ({
            contacts: [...state.contacts, created],
            isLoading: false,
          }));
        } catch (error) {
          const msg = error instanceof Error ? error.message : 'Failed to create contact';
          set({ error: msg, isLoading: false });
          throw error;
        }
      },

      updateContact: async (client, id, updates) => {
        set({ error: null });
        try {
          await client.updateContact(id, updates);
          set((state) => ({
            contacts: state.contacts.map(c =>
              c.id === id ? { ...c, ...updates } : c
            ),
          }));
        } catch (error) {
          const msg = error instanceof Error ? error.message : 'Failed to update contact';
          set({ error: msg });
          throw error;
        }
      },

      deleteContact: async (client, id) => {
        set({ error: null });
        try {
          await client.deleteContact(id);
          set((state) => ({
            contacts: state.contacts.filter(c => c.id !== id),
            selectedContactId: state.selectedContactId === id ? null : state.selectedContactId,
          }));
        } catch (error) {
          const msg = error instanceof Error ? error.message : 'Failed to delete contact';
          set({ error: msg });
          throw error;
        }
      },

      addLocalContact: (contact) => set((state) => ({
        contacts: [...state.contacts, contact],
      })),

      updateLocalContact: (id, updates) => set((state) => ({
        contacts: state.contacts.map(c =>
          c.id === id ? { ...c, ...updates } : c
        ),
      })),

      deleteLocalContact: (id) => set((state) => ({
        contacts: state.contacts.filter(c => c.id !== id),
        selectedContactId: state.selectedContactId === id ? null : state.selectedContactId,
      })),

      setSelectedContact: (id) => set({ selectedContactId: id }),
      setSearchQuery: (query) => set({ searchQuery: query }),
      setSupportsSync: (supports) => set({ supportsSync: supports }),
      setActiveTab: (tab) => set({ activeTab: tab }),

      clearContacts: () => set({
        contacts: [],
        addressBooks: [],
        selectedContactId: null,
        searchQuery: '',
        error: null,
        selectedContactIds: new Set<string>(),
        activeTab: 'all',
      }),

      getAutocomplete: (query) => {
        const { contacts } = get();
        if (!query || query.length < 1) return [];

        const lower = query.toLowerCase();
        const results: Array<{ name: string; email: string }> = [];

        for (const contact of contacts) {
          if (contact.kind === 'group') {
            const groupName = getContactDisplayName(contact);
            if (groupName.toLowerCase().includes(lower)) {
              const members = get().getGroupMembers(contact.id);
              for (const member of members) {
                const memberName = getContactDisplayName(member);
                const memberEmails = member.emails ? Object.values(member.emails) : [];
                for (const emailEntry of memberEmails) {
                  if (!emailEntry.address) continue;
                  results.push({ name: memberName, email: emailEntry.address });
                }
              }
            }
            continue;
          }

          const name = getContactDisplayName(contact);
          const emails = contact.emails ? Object.values(contact.emails) : [];

          for (const emailEntry of emails) {
            if (!emailEntry.address) continue;
            if (
              name.toLowerCase().includes(lower) ||
              emailEntry.address.toLowerCase().includes(lower)
            ) {
              results.push({ name, email: emailEntry.address });
            }
          }

          if (results.length >= 10) break;
        }

        return results;
      },

      getGroups: () => {
        return get().contacts.filter(c => c.kind === 'group');
      },

      getIndividuals: () => {
        return get().contacts.filter(c => c.kind !== 'group');
      },

      getGroupMembers: (groupId) => {
        const { contacts } = get();
        const group = contacts.find(c => c.id === groupId);
        if (!group?.members) return [];
        const memberKeys = Object.keys(group.members).filter(k => group.members![k]);
        // Normalize: strip urn:uuid: prefix for matching
        const normalizedKeys = memberKeys.map(k => k.startsWith('urn:uuid:') ? k.slice(9) : k);
        return contacts.filter(c => {
          if (memberKeys.includes(c.id) || normalizedKeys.includes(c.id)) return true;
          if (c.uid) {
            const bareUid = c.uid.startsWith('urn:uuid:') ? c.uid.slice(9) : c.uid;
            return memberKeys.includes(c.uid) || normalizedKeys.includes(bareUid);
          }
          return false;
        });
      },

      createGroup: async (client, name, memberIds) => {
        const { contacts } = get();
        const members: Record<string, boolean> = {};
        memberIds.forEach(id => {
          const contact = contacts.find(c => c.id === id);
          const key = contact?.uid || id;
          members[key] = true;
        });

        const groupData: Partial<ContactCard> = {
          kind: 'group',
          name: { components: [{ kind: 'given', value: name }], isOrdered: true },
          members,
        };

        if (client && get().supportsSync) {
          const created = await client.createContact(groupData);
          set((state) => ({ contacts: [...state.contacts, created] }));
        } else {
          const localGroup: ContactCard = {
            id: `local-${crypto.randomUUID()}`,
            addressBookIds: {},
            ...groupData,
          } as ContactCard;
          set((state) => ({ contacts: [...state.contacts, localGroup] }));
        }
      },

      updateGroup: async (client, groupId, name) => {
        const updates: Partial<ContactCard> = {
          name: { components: [{ kind: 'given', value: name }], isOrdered: true },
        };
        if (client && get().supportsSync) {
          await client.updateContact(groupId, updates);
        }
        set((state) => ({
          contacts: state.contacts.map(c =>
            c.id === groupId ? { ...c, ...updates } : c
          ),
        }));
      },

      addMembersToGroup: async (client, groupId, memberIds) => {
        const { contacts } = get();
        const group = contacts.find(c => c.id === groupId);
        if (!group) return;

        const newMembers = { ...group.members };
        memberIds.forEach(id => {
          const contact = contacts.find(c => c.id === id);
          const key = contact?.uid || id;
          newMembers[key] = true;
        });

        const updates: Partial<ContactCard> = { members: newMembers };
        if (client && get().supportsSync) {
          await client.updateContact(groupId, updates);
        }
        set((state) => ({
          contacts: state.contacts.map(c =>
            c.id === groupId ? { ...c, members: newMembers } : c
          ),
        }));
      },

      removeMembersFromGroup: async (client, groupId, memberIds) => {
        const { contacts } = get();
        const group = contacts.find(c => c.id === groupId);
        if (!group?.members) return;

        const newMembers = { ...group.members };
        memberIds.forEach(id => {
          // Try direct id match first
          if (newMembers[id] !== undefined) {
            delete newMembers[id];
            return;
          }
          // Try uid-based match
          const contact = contacts.find(c => c.id === id);
          if (contact?.uid && newMembers[contact.uid] !== undefined) {
            delete newMembers[contact.uid];
          } else {
            // Try stripping urn:uuid: prefix matching
            for (const key of Object.keys(newMembers)) {
              const bareKey = key.startsWith('urn:uuid:') ? key.slice(9) : key;
              const bareUid = contact?.uid?.startsWith('urn:uuid:') ? contact.uid.slice(9) : contact?.uid;
              if (bareKey === id || bareKey === bareUid) {
                delete newMembers[key];
                break;
              }
            }
          }
        });

        const updates: Partial<ContactCard> = { members: newMembers };
        if (client && get().supportsSync) {
          await client.updateContact(groupId, updates);
        }
        set((state) => ({
          contacts: state.contacts.map(c =>
            c.id === groupId ? { ...c, members: newMembers } : c
          ),
        }));
      },

      deleteGroup: async (client, groupId) => {
        if (client && get().supportsSync) {
          await client.deleteContact(groupId);
        }
        set((state) => ({
          contacts: state.contacts.filter(c => c.id !== groupId),
          selectedContactId: state.selectedContactId === groupId ? null : state.selectedContactId,
        }));
      },

      toggleContactSelection: (id) => set((state) => {
        const next = new Set(state.selectedContactIds);
        if (next.has(id)) {
          next.delete(id);
        } else {
          next.add(id);
        }
        return { selectedContactIds: next };
      }),

      selectAllContacts: (ids) => set({ selectedContactIds: new Set(ids) }),

      clearSelection: () => set({ selectedContactIds: new Set<string>() }),

      bulkDeleteContacts: async (client, ids) => {
        set({ error: null });
        const { supportsSync } = get();
        const deletedIds = new Set(ids);

        if (client && supportsSync) {
          for (const id of ids) {
            try {
              await client.deleteContact(id);
            } catch (error) {
              console.error(`Failed to delete contact ${id}:`, error);
              deletedIds.delete(id);
            }
          }
          if (deletedIds.size < ids.length) {
            set({ error: `Failed to delete ${ids.length - deletedIds.size} contact(s)` });
          }
        }

        set((state) => ({
          contacts: state.contacts.filter(c => !deletedIds.has(c.id)),
          selectedContactId: deletedIds.has(state.selectedContactId || '') ? null : state.selectedContactId,
          selectedContactIds: new Set<string>(),
        }));
      },

      bulkAddToGroup: async (client, groupId, contactIds) => {
        await get().addMembersToGroup(client, groupId, contactIds);
        set({ selectedContactIds: new Set<string>() });
      },

      importContacts: async (client, contacts) => {
        const { supportsSync } = get();
        let imported = 0;

        for (const contact of contacts) {
          try {
            if (client && supportsSync) {
              const { id: _id, ...data } = contact;
              const created = await client.createContact(data);
              set((state) => ({ contacts: [...state.contacts, created] }));
            } else {
              const localContact: ContactCard = {
                ...contact,
                id: `local-${crypto.randomUUID()}`,
              };
              set((state) => ({ contacts: [...state.contacts, localContact] }));
            }
            imported++;
          } catch (error) {
            console.error('Failed to import contact:', error);
          }
        }

        return imported;
      },
    }),
    {
      name: 'contact-storage',
      partialize: (state) => ({
        contacts: state.supportsSync ? [] : state.contacts,
        supportsSync: state.supportsSync,
      }),
    }
  )
);

export type { ContactName };
