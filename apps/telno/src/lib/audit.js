import { db_ } from '../db/index.js';
import { hashIp } from './security.js';

/**
 * Append-only operator trail. IPs are hashed, never stored raw, so the log is
 * useful for abuse review without becoming a personal-data store.
 */
export function logEvent({ actor = 'system', action, subject = '', detail = '', ip }) {
  try {
    db_.run('INSERT INTO events (actor, action, subject, detail, ip_hash) VALUES (?, ?, ?, ?, ?)', [
      String(actor).slice(0, 120),
      String(action).slice(0, 80),
      String(subject).slice(0, 200),
      typeof detail === 'string' ? detail.slice(0, 2000) : JSON.stringify(detail).slice(0, 2000),
      ip ? hashIp(ip) : '',
    ]);
  } catch (err) {
    console.error('[audit] could not record event', action, err.message);
  }
}

export const recentEvents = (limit = 50) =>
  db_.all('SELECT * FROM events ORDER BY id DESC LIMIT ?', [Math.min(Number(limit) || 50, 200)]);
