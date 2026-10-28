import { badRequest } from './errors.js';

/**
 * Shared vocabulary for the device inventory. Both the authenticated estate
 * routes and the token-authenticated heartbeat use these, so a value accepted
 * at provisioning time is also accepted — and understood — by a check-in.
 */

export const DEVICE_KINDS = ['handset', 'gateway', 'ata', 'conference', 'door'];
export const DEVICE_STATES = ['online', 'offline', 'provisioning', 'faulty'];

/** MACs are stored in one canonical form so uniqueness actually holds. */
export function normalizeMac(value) {
  const text = String(value ?? '').trim().toUpperCase();
  if (!text) return '';
  const hex = text.replace(/[^0-9A-F]/g, '');
  if (hex.length !== 12) throw badRequest('mac must contain 12 hex digits');
  return hex.match(/../g).join(':');
}

export function normalizeIp(value) {
  const text = String(value ?? '').trim();
  if (!text) return '';
  if (!/^[0-9a-fA-F:.]+$/.test(text) || text.length > 45) throw badRequest('ip must be an IPv4 or IPv6 address');
  return text;
}

/** A live device that has not checked in for a while is silent, not online. */
export function isSilent(row, staleAfterSec) {
  if (row.status !== 'online') return false;
  if (!row.last_seen_at) return true;
  const seen = Date.parse(row.last_seen_at);
  if (Number.isNaN(seen)) return true;
  return Date.now() - seen > staleAfterSec * 1000;
}
