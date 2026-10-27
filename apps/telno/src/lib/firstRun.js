import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../config.js';

/**
 * The password a fresh install generates for its owner.
 *
 * It used to be printed to standard output and nowhere else. That is a bad
 * place for the only credential to a brand new platform: a container log ends
 * up in a scrollback, a log driver, a screenshot and a support ticket, and the
 * person who needs the password next week is the one who can read the data
 * volume. So the password is written there instead — next to the database, mode
 * 0600 — and boot prints the *path*.
 *
 * The file is a bootstrap artifact, not a stored secret: the moment the owner
 * sets a password of their own it is deleted, because the generated one is dead
 * from then on. Nothing else reads it.
 */

export const firstRunPasswordFile = (dir = config.dataDir) => join(dir, 'first-run-password.txt');

/** Write the generated credential for a fresh install. Returns its path. */
export function writeFirstRunPassword(email, password, dir = config.dataDir) {
  const file = firstRunPasswordFile(dir);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    file,
    `email:    ${email}\npassword: ${password}\n\nSign in with it, then change the password under Account in the console —\nthat removes this file, because the generated password dies then.\n`,
    { mode: 0o600 }
  );
  // writeFileSync's mode is masked by the process umask (022 in most images),
  // which would leave a plaintext password world-readable.
  chmodSync(file, 0o600);
  return file;
}

/**
 * Is the generated credential still there to be retired? The console asks this
 * so it can tell an owner that a fresh install's password is still on the
 * volume, and so it can say when a change took it away. Existence only — the
 * file's contents are never read here.
 */
export function firstRunPasswordPending(dir = config.dataDir) {
  return existsSync(firstRunPasswordFile(dir));
}

/**
 * Remove it, once the generated password has been replaced. Best effort on
 * purpose: a failure here must never break the password change that triggered
 * it, which has already been committed to the database.
 */
export function clearFirstRunPassword(dir = config.dataDir) {
  const file = firstRunPasswordFile(dir);
  if (!existsSync(file)) return false;
  try {
    rmSync(file, { force: true });
    return true;
  } catch {
    return false;
  }
}
