import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { config } from '../config.js';

/**
 * Internal secure messaging.
 *
 * A message between two people on this platform never leaves it: it is written
 * to this database, delivered in the app, and there is no carrier, no per-message
 * fee and no third party holding a copy. That is the point — the alternative on
 * this deployment is a paid SMS gateway, and messages on it are metered twice
 * (once by the carrier, once by whoever runs the gateway).
 *
 * "Secure" is not a label here: the body is sealed with AES-256-GCM before it is
 * written, so a copy of the database file, a backup archive or a stolen volume is
 * not a copy of anybody's conversations. The key is derived from the deployment's
 * own secret, which means it lives in the environment and not next to the data.
 */

let cachedKey = null;

function key() {
  if (cachedKey) return cachedKey;
  const secret = config.sessionSecret || config.apiKeyPepper || '';
  if (!secret) throw new Error('secure messaging needs SESSION_SECRET to derive its key');
  // scrypt rather than a bare hash: the secret may be human-chosen, and the salt
  // is fixed on purpose so every node with the same secret can read the history.
  cachedKey = scryptSync(secret, 'telno-secure-messaging-v1', 32);
  return cachedKey;
}

export function seal(text) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(), iv);
  const body = Buffer.concat([cipher.update(String(text ?? ''), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ['v1', iv.toString('base64'), tag.toString('base64'), body.toString('base64')].join('.');
}

/** Returns '' rather than throwing when a payload cannot be opened. */
export function open(payload) {
  const parts = String(payload || '').split('.');
  if (parts.length !== 4 || parts[0] !== 'v1') return '';
  try {
    const decipher = createDecipheriv('aes-256-gcm', key(), Buffer.from(parts[1], 'base64'));
    decipher.setAuthTag(Buffer.from(parts[2], 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(parts[3], 'base64')), decipher.final()]).toString('utf8');
  } catch {
    return '';
  }
}

/** One conversation, named the same way from both ends. */
export const threadId = (a, b) => [String(a || '').toLowerCase(), String(b || '').toLowerCase()].sort().join('|');
