/**
 * Utilities for multi-account support:
 * - Account ID generation
 * - Deterministic avatar colors
 * - Account-scoped localStorage keys
 */

/** Generate a unique, deterministic account ID from username and server URL */
export function generateAccountId(username: string, serverUrl: string): string {
  try {
    const host = new URL(serverUrl).hostname;
    return `${username}@${host}`;
  } catch {
    // Relative URL (e.g. /api/dev-jmap) – use current origin as base
    const base = typeof window !== 'undefined' ? window.location.origin : 'http://localhost';
    const host = new URL(serverUrl, base).hostname;
    return `${username}@${host}`;
  }
}

/** Deterministic avatar/accent color from an email string */
export function generateAvatarColor(email: string): string {
  let hash = 0;
  for (let i = 0; i < email.length; i++) {
    hash = ((hash << 5) - hash + email.charCodeAt(i)) | 0;
  }
  // 12 distinct, accessible hues
  const colors = [
    '#2563eb', // blue
    '#7c3aed', // violet
    '#db2777', // pink
    '#dc2626', // red
    '#ea580c', // orange
    '#d97706', // amber
    '#65a30d', // lime
    '#16a34a', // green
    '#0d9488', // teal
    '#0891b2', // cyan
    '#6366f1', // indigo
    '#9333ea', // purple
  ];
  return colors[Math.abs(hash) % colors.length];
}

/** Get initials for an avatar from a display name or email */
export function getInitials(name: string, email?: string): string {
  if (name) {
    const parts = name.trim().split(/\s+/);
    if (parts.length >= 2) {
      return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
    }
    return parts[0][0]?.toUpperCase() ?? '?';
  }
  if (email) {
    return email[0]?.toUpperCase() ?? '?';
  }
  return '?';
}

/** Build an account-scoped localStorage key */
export function getAccountScopedKey(baseKey: string, accountId: string): string {
  return `${baseKey}::${accountId}`;
}

/** Maximum number of accounts allowed */
export const MAX_ACCOUNTS = 5;
