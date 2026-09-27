// Failed password step-ups for "Link mobile app", per signed-in account.
//
// The step-up checks the typed password against the mail server from this
// server's address. Stalwart bans an address after too many failed logins
// (100 a day per IP or login name) - across the whole server - so a signed-in
// session must not be able to guess passwords through the webmail and get it
// banned for everyone. A handful of mistakes is plenty for a person.
//
// An attempt counts as a failure from the moment it starts, and is given back
// only once it turns out not to have been a wrong credential: otherwise
// parallel requests would all pass the check before the first one failed.

const MAX_FAILURES = 5;
const WINDOW_MS = 15 * 60 * 1000;
const STORE_KEY = '__bulwarkPairAttempts';

interface Entry {
  failures: number;
  windowStart: number;
}

function store(): Map<string, Entry> {
  const g = globalThis as typeof globalThis & { [STORE_KEY]?: Map<string, Entry> };
  if (!g[STORE_KEY]) g[STORE_KEY] = new Map();
  return g[STORE_KEY];
}

function live(key: string, now: number): Entry | null {
  const entry = store().get(key);
  if (!entry) return null;
  if (now - entry.windowStart >= WINDOW_MS) {
    store().delete(key);
    return null;
  }
  return entry;
}

export function isPairStepUpLocked(key: string, now = Date.now()): boolean {
  return (live(key, now)?.failures ?? 0) >= MAX_FAILURES;
}

export function recordPairStepUpFailure(key: string, now = Date.now()): void {
  const entry = live(key, now);
  if (entry) entry.failures += 1;
  else store().set(key, { failures: 1, windowStart: now });
  // Bound the map: drop windows that ran out.
  for (const [k, e] of store()) {
    if (now - e.windowStart >= WINDOW_MS) store().delete(k);
  }
}

/**
 * Start a step-up: false when the account is locked out, otherwise the
 * attempt is counted as a failure until {@link settlePairStepUp} says better.
 */
export function beginPairStepUp(key: string, now = Date.now()): boolean {
  if (isPairStepUpLocked(key, now)) return false;
  recordPairStepUpFailure(key, now);
  return true;
}

/**
 * Finish a step-up begun with {@link beginPairStepUp}: a success clears the
 * count, a wrong credential keeps its failure, anything else (the server was
 * unreachable, pairing is unavailable) gives the attempt back.
 */
export function settlePairStepUp(key: string, outcome: 'success' | 'wrong_credential' | 'other'): void {
  if (outcome === 'success') {
    clearPairStepUpFailures(key);
    return;
  }
  if (outcome === 'other') {
    const entry = store().get(key);
    if (entry) entry.failures = Math.max(0, entry.failures - 1);
  }
}

export function clearPairStepUpFailures(key: string): void {
  store().delete(key);
}
