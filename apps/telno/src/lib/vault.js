import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { db_, now } from '../db/index.js';
import { config } from '../config.js';
import { badRequest } from './errors.js';

/**
 * The vault holds third-party credentials — a mail provider key, an SMS token —
 * so they can be set and rotated from the console instead of being baked into
 * the image or a chat message.
 *
 *   putSecret('RESEND_API_KEY', 're_…', 'owner@example.com')
 *   getSecret('RESEND_API_KEY')     -> the value, server-side only
 *   listSecrets()                   -> names, hints and dates, never values
 *
 * Values are AES-256-GCM encrypted with a key derived from SESSION_SECRET. That
 * keeps a stray copy of the SQLite file from disclosing a provider key, and it
 * means rotating SESSION_SECRET invalidates the stored values: they have to be
 * entered again. The trade is deliberate — one secret protects them all rather
 * than a second key that would also have to live somewhere in the container.
 */

const NAME = /^[A-Z][A-Z0-9_]{2,63}$/;

const keyMaterial = () =>
  createHash('sha256').update(`telno-vault:${config.sessionSecret}`).digest();

function encrypt(value) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', keyMaterial(), iv);
  const body = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), body.toString('base64')].join('.');
}

function decrypt(blob) {
  const [version, iv, tag, body] = String(blob).split('.');
  if (version !== 'v1' || !iv || !tag || !body) throw new Error('unsupported secret format');
  const decipher = createDecipheriv('aes-256-gcm', keyMaterial(), Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(body, 'base64')), decipher.final()]).toString('utf8');
}

/** Last four characters only: enough to recognize a key, not enough to use it. */
export const hintOf = (value) => (String(value).length <= 4 ? '••••' : `••••${String(value).slice(-4)}`);

export const isSecretName = (name) => NAME.test(String(name || ''));

export function assertSecretName(raw) {
  const name = String(raw || '').trim().toUpperCase();
  if (!isSecretName(name)) {
    throw badRequest('A secret name is upper case, starts with a letter and uses A–Z, 0–9 and _ (e.g. RESEND_API_KEY)');
  }
  return name;
}

const view = (row) => ({
  name: row.name,
  hint: row.hint,
  updatedAt: row.updated_at,
  updatedBy: row.updated_by,
});

export function putSecret(rawName, rawValue, actor = '') {
  const name = assertSecretName(rawName);
  const value = String(rawValue ?? '').trim();
  if (!value) throw badRequest('A secret value is required');
  if (value.length > 4096) throw badRequest('A secret value must be under 4096 characters');
  db_.run(
    `INSERT INTO secrets (name, cipher, hint, updated_at, updated_by) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (name) DO UPDATE SET cipher = excluded.cipher, hint = excluded.hint,
       updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
    [name, encrypt(value), hintOf(value), now(), actor]
  );
  return view(db_.get('SELECT * FROM secrets WHERE name = ?', [name]));
}

/**
 * The value, or an empty string when it is absent or unreadable. A rotated
 * SESSION_SECRET makes old ciphertext undecryptable; that is a missing secret,
 * not a crash, so the caller falls back to its own default.
 */
export function getSecret(rawName) {
  const name = String(rawName || '').trim().toUpperCase();
  if (!isSecretName(name)) return '';
  const row = db_.get('SELECT cipher FROM secrets WHERE name = ?', [name]);
  if (!row) return '';
  try {
    return decrypt(row.cipher);
  } catch {
    console.warn(`[vault] ${name} could not be decrypted — re-enter it in Settings`);
    return '';
  }
}

export const hasSecret = (name) => !!getSecret(name);

export function listSecrets() {
  return db_.all('SELECT * FROM secrets ORDER BY name').map(view);
}

export function deleteSecret(rawName) {
  const name = assertSecretName(rawName);
  const row = db_.get('SELECT name FROM secrets WHERE name = ?', [name]);
  if (!row) return false;
  db_.run('DELETE FROM secrets WHERE name = ?', [name]);
  return true;
}
