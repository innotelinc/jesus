import { randomBytes } from 'node:crypto';
import { db_, newId } from '../db/index.js';
import { badRequest, conflict } from './errors.js';

/**
 * Create a line.
 *
 * One insert, because a line now comes from two directions — the Extensions
 * screen and the first-run setup — and the switch reads this row. A line that
 * differs depending on where it was made is a support call waiting to happen:
 * the same defaults (voicemail on, enabled, a generated SIP secret) have to
 * apply either way.
 */
export function insertExtension({
  extension,
  displayName,
  email = '',
  secret = '',
  voicemail = true,
  dnd = false,
  forwardTo = '',
  enabled = true,
  numberId = null,
  accountId = null,
} = {}) {
  const value = String(extension ?? '').trim();
  if (!/^\d{2,6}$/.test(value)) throw badRequest('An extension is 2 to 6 digits, for example 101');
  if (db_.get('SELECT id FROM extensions WHERE extension = ?', [value])) {
    throw conflict(`Extension ${value} already exists`);
  }
  const password = secret || randomBytes(9).toString('base64url');
  const id = newId('ext_');
  db_.run(
    `INSERT INTO extensions (id, extension, display_name, number_id, email, secret, voicemail, dnd,
                             forward_to, enabled, account_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      value,
      displayName,
      numberId,
      email,
      password,
      voicemail ? 1 : 0,
      dnd ? 1 : 0,
      forwardTo,
      enabled ? 1 : 0,
      accountId,
    ]
  );
  return db_.get('SELECT * FROM extensions WHERE id = ?', [id]);
}

/** Look a line up the way an operator names it: by its extension number. */
export const extensionByNumber = (extension) =>
  db_.get('SELECT * FROM extensions WHERE extension = ?', [String(extension ?? '').trim()]);

/**
 * The next free extension.
 *
 * A fresh install should offer the number an operator expects to dial — 101 —
 * rather than making them pick one and then discover it is taken. If the 1xx
 * range is full the search continues, and an empty string means there is
 * nothing left to suggest (999 lines is a switch, not a startup).
 */
export function suggestExtension() {
  const taken = new Set(db_.all('SELECT extension FROM extensions').map((row) => String(row.extension)));
  for (let candidate = 101; candidate <= 999; candidate += 1) {
    if (!taken.has(String(candidate))) return String(candidate);
  }
  return '';
}
