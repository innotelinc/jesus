/**
 * Which SMS replies the operator has already read.
 *
 * The inbox log is append-only — the phone's poller writes it, and there is no
 * per-operator column to mark a row read — so "unread" is a browser-side fact:
 * an inbound message whose id has not been seen in an open thread yet. Ids come
 * from the phone (number + date + body) and are stable across polls, so the
 * marker survives a reload, and opening a thread costs a localStorage write
 * instead of an API call.
 *
 * The marker is per browser profile, not per account: two operators sharing one
 * machine share what counts as read. That matches the rest of the Control
 * Center's local preferences (theme, sidebar, settings).
 */
import type { SmsMessage } from './api';

/** Fired on `window` when the read set changes, so the sidebar badge retracts. */
export const SMS_READ_CHANGED_EVENT = 'capstone:sms-read';

const READ_KEY = 'capstone.sms.read';

// The badge counts messages from the current inbox (≤200 rows), but the store
// outlives any one poll, so it keeps a generous window. Ids are dropped
// oldest-first; a reply would have to be read and then 1000 further replies
// read before it could resurface as unread.
const MAX_READ_IDS = 1000;

/** Ids of replies this browser has opened. Unreadable storage means none. */
export function loadReadSmsIds(): Set<string> {
  try {
    const raw = window.localStorage.getItem(READ_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return new Set(
      Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : [],
    );
  } catch {
    // Storage blocked or corrupt: nothing is remembered, which at worst badges
    // messages the operator has already seen.
    return new Set();
  }
}

/**
 * Mark replies read. A no-op when every id is already known, so a page that
 * re-renders on each poll does not write storage or churn the badge.
 */
export function markSmsRead(ids: string[]): void {
  const fresh = ids.filter(Boolean);
  if (fresh.length === 0) return;

  const read = loadReadSmsIds();
  const before = read.size;
  fresh.forEach(id => read.add(id));
  if (read.size === before) return;

  try {
    window.localStorage.setItem(READ_KEY, JSON.stringify([...read].slice(-MAX_READ_IDS)));
  } catch {
    // Not persisted — the event still fires so this session's badge agrees with
    // the thread on screen; the next reload remembers nothing.
  }
  window.dispatchEvent(new CustomEvent(SMS_READ_CHANGED_EVENT));
}

/**
 * Replies the operator has not opened yet. Outbound rows are always read, and a
 * row without an id cannot be tracked, so it is excluded rather than badged
 * forever.
 */
export function unreadSms(messages: SmsMessage[], read: Set<string>): SmsMessage[] {
  return messages.filter(
    message => message.direction !== 'out' && Boolean(message.id) && !read.has(message.id),
  );
}
