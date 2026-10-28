/**
 * Browser-side settings store for the Control Center.
 *
 * dashboard-api has no settings table, so per-operator preferences (Access,
 * Notifications, Dashboard behavior, Profile) persist to localStorage under
 * `capstone.settings.*`. Saving dispatches SETTINGS_CHANGED_EVENT so live
 * consumers (e.g. the data-context poll interval) react without a reload.
 */

export const SETTINGS_CHANGED_EVENT = 'capstone:settings-changed';

export const STORAGE_KEYS = {
  access: 'capstone.settings.access',
  notifications: 'capstone.settings.notifications',
  dashboard: 'capstone.settings.dashboard',
  profile: 'capstone.settings.profile',
} as const;

export interface AccessSettings {
  sessionTimeout: string;
  requireMfa: boolean;
  ipAllowList: boolean;
  ipRanges: string;
}

export const DEFAULT_ACCESS: AccessSettings = {
  sessionTimeout: '60',
  requireMfa: false,
  ipAllowList: true,
  ipRanges: '203.0.113.0/24',
};

export const NOTIFY_ON_OPTIONS = [
  'Critical alerts',
  'Warning alerts',
  'Secret expiry reminders',
  'Config changes',
  'Audit log events',
] as const;

export interface NotificationsSettings {
  email: string;
  slackAlerts: boolean;
  notifyOn: string[];
}

export const DEFAULT_NOTIFICATIONS: NotificationsSettings = {
  email: 'maya@capstone.internal',
  slackAlerts: true,
  notifyOn: ['Critical alerts', 'Secret expiry reminders'],
};

export interface DashboardSettings {
  /** Seconds between background refreshes; '0' = off. */
  autoRefreshSeconds: string;
  exportFormat: 'csv' | 'json' | 'pdf';
  compactView: boolean;
  showTrends: boolean;
}

export const DEFAULT_DASHBOARD: DashboardSettings = {
  autoRefreshSeconds: '30',
  exportFormat: 'csv',
  compactView: false,
  showTrends: true,
};

export interface ProfileSettings {
  displayName: string;
  email: string;
  showEmail: boolean;
}

export const DEFAULT_PROFILE: ProfileSettings = {
  displayName: 'Maya K.',
  email: 'maya@capstone.internal',
  showEmail: true,
};

function load<T>(key: string, fallback: T): T {
  try {
    const raw = window.localStorage.getItem(key);
    if (raw) return { ...fallback, ...(JSON.parse(raw) as Partial<T>) };
  } catch {
    // unreadable/corrupt storage → defaults
  }
  return fallback;
}

function persist(key: string, value: unknown): boolean {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
    window.dispatchEvent(new CustomEvent(SETTINGS_CHANGED_EVENT, { detail: { key } }));
    return true;
  } catch {
    // storage full/blocked — caller still shows the failure-free acknowledgement
    return false;
  }
}

export const settingsStore = {
  loadAccess: () => load(STORAGE_KEYS.access, DEFAULT_ACCESS),
  loadNotifications: () => load(STORAGE_KEYS.notifications, DEFAULT_NOTIFICATIONS),
  loadDashboard: () => load(STORAGE_KEYS.dashboard, DEFAULT_DASHBOARD),
  loadProfile: () => load(STORAGE_KEYS.profile, DEFAULT_PROFILE),

  saveAccess: (v: AccessSettings) => persist(STORAGE_KEYS.access, v),
  saveNotifications: (v: NotificationsSettings) => persist(STORAGE_KEYS.notifications, v),
  saveDashboard: (v: DashboardSettings) => persist(STORAGE_KEYS.dashboard, v),
  saveProfile: (v: ProfileSettings) => persist(STORAGE_KEYS.profile, v),
};

/** Milliseconds for an auto-refresh value ('0' = off → 0). */
export function pollIntervalMs(autoRefreshSeconds: string): number {
  const n = Number(autoRefreshSeconds);
  return Number.isFinite(n) && n > 0 ? Math.round(n * 1000) : 0;
}
