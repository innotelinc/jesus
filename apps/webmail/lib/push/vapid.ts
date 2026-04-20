import crypto from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { b64uDecode, b64uEncode } from './base64url';

interface StoredVapid {
  publicKey: string;
  privateKeyPem: string;
  subject: string;
}

export interface VapidKeys {
  publicKey: string;
  publicKeyBuf: Buffer;
  privateKeyPem: string;
  subject: string;
}

function getVapidPath(): string {
  const dir = process.env.PUSH_DATA_DIR || path.join(process.cwd(), 'data', 'push');
  return path.join(dir, 'vapid.json');
}

function getSubject(): string {
  return process.env.VAPID_SUBJECT?.trim() || 'mailto:admin@localhost';
}

// P-256 SPKI DER wraps a 26-byte algorithm identifier followed by a BIT STRING
// containing the uncompressed point (0x04 || X || Y). Strip the header to get
// the raw 65-byte public key that VAPID requires.
function extractUncompressedPoint(spkiDer: Buffer): Buffer {
  if (spkiDer.length < 65) throw new Error('SPKI DER too short for P-256');
  return spkiDer.subarray(spkiDer.length - 65);
}

let cached: VapidKeys | null = null;
let loading: Promise<VapidKeys> | null = null;

async function loadOrCreate(): Promise<VapidKeys> {
  const file = getVapidPath();
  try {
    const raw = await readFile(file, 'utf-8');
    const parsed = JSON.parse(raw) as StoredVapid;
    return {
      publicKey: parsed.publicKey,
      publicKeyBuf: b64uDecode(parsed.publicKey),
      privateKeyPem: parsed.privateKeyPem,
      subject: parsed.subject,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', {
    namedCurve: 'prime256v1',
  });
  const spki = publicKey.export({ format: 'der', type: 'spki' });
  const uncompressed = extractUncompressedPoint(spki);
  const privateKeyPem = privateKey.export({ format: 'pem', type: 'pkcs8' }) as string;
  const stored: StoredVapid = {
    publicKey: b64uEncode(uncompressed),
    privateKeyPem,
    subject: getSubject(),
  };

  const dir = path.dirname(file);
  if (!existsSync(dir)) await mkdir(dir, { recursive: true });
  const tmp = file + '.tmp';
  await writeFile(tmp, JSON.stringify(stored, null, 2), 'utf-8');
  await import('node:fs/promises').then((fs) => fs.rename(tmp, file));

  return {
    publicKey: stored.publicKey,
    publicKeyBuf: uncompressed,
    privateKeyPem: stored.privateKeyPem,
    subject: stored.subject,
  };
}

export async function getVapidKeys(): Promise<VapidKeys> {
  if (cached) return cached;
  if (!loading) {
    loading = loadOrCreate().then((keys) => {
      cached = keys;
      return keys;
    });
  }
  return loading;
}
