import { create } from 'zustand';
import { persist } from 'zustand/middleware';

// Settings sync state (module-level, not persisted)
let syncEnabled = false;
let syncUsername: string | null = null;
let syncServerUrl: string | null = null;
let syncTimeout: ReturnType<typeof setTimeout> | null = null;
let isLoadingFromServer = false;

const SYNC_DEBOUNCE_MS = 2000;

export type FontSize = 'small' | 'medium' | 'large';
export type ListDensity = 'compact' | 'regular' | 'comfortable';
export type DeleteAction = 'trash' | 'permanent';
export type ReplyMode = 'reply' | 'replyAll';
export type DateFormat = 'regional' | 'iso' | 'custom';
export type TimeFormat = '12h' | '24h';
export type FirstDayOfWeek = 0 | 1; // 0 = Sunday, 1 = Monday
export type ExternalContentPolicy = 'ask' | 'block' | 'allow';

interface SettingsState {
  // Appearance
  fontSize: FontSize;
  listDensity: ListDensity;
  animationsEnabled: boolean;

  // Language & Region
  dateFormat: DateFormat;
  timeFormat: TimeFormat;
  firstDayOfWeek: FirstDayOfWeek;

  // Email Behavior
  markAsReadDelay: number; // milliseconds (0 = instant, -1 = never)
  deleteAction: DeleteAction;
  showPreview: boolean;
  emailsPerPage: number;
  externalContentPolicy: ExternalContentPolicy;

  // Composer
  autoSaveDraftInterval: number; // milliseconds
  sendConfirmation: boolean;
  defaultReplyMode: ReplyMode;

  // Privacy & Security
  sessionTimeout: number; // minutes (0 = never)
  trustedSenders: string[]; // Email addresses that can load external content

  // Calendar Notifications
  calendarNotificationsEnabled: boolean;
  calendarNotificationSound: boolean;

  // Experimental
  senderFavicons: boolean;

  // Folders
  folderIcons: Record<string, string>; // mailboxId -> icon name

  // Advanced
  debugMode: boolean;

  // Actions
  updateSetting: <K extends keyof SettingsState>(
    key: K,
    value: SettingsState[K]
  ) => void;
  resetToDefaults: () => void;
  exportSettings: () => string;
  importSettings: (json: string) => boolean;

  // Folder icons
  setFolderIcon: (mailboxId: string, icon: string) => void;
  removeFolderIcon: (mailboxId: string) => void;

  // Trusted senders
  addTrustedSender: (email: string) => void;
  removeTrustedSender: (email: string) => void;
  isSenderTrusted: (email: string) => boolean;

  // Settings sync
  enableSync: (username: string, serverUrl: string) => void;
  disableSync: () => void;
  loadFromServer: (username: string, serverUrl: string) => Promise<boolean>;
}

const DEFAULT_SETTINGS = {
  // Appearance
  fontSize: 'medium' as FontSize,
  listDensity: 'regular' as ListDensity,
  animationsEnabled: true,

  // Language & Region
  dateFormat: 'regional' as DateFormat,
  timeFormat: '24h' as TimeFormat,
  firstDayOfWeek: 1 as FirstDayOfWeek, // Monday

  // Email Behavior
  markAsReadDelay: 0, // Instant
  deleteAction: 'trash' as DeleteAction,
  showPreview: true,
  emailsPerPage: 50,
  externalContentPolicy: 'ask' as ExternalContentPolicy,

  // Composer
  autoSaveDraftInterval: 60000, // 1 minute
  sendConfirmation: false,
  defaultReplyMode: 'reply' as ReplyMode,

  // Privacy & Security
  sessionTimeout: 0, // Never
  trustedSenders: [] as string[],

  // Calendar Notifications
  calendarNotificationsEnabled: true,
  calendarNotificationSound: true,

  // Experimental
  senderFavicons: true,

  // Folders
  folderIcons: {} as Record<string, string>,

  // Advanced
  debugMode: false,
};

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set, get) => ({
      ...DEFAULT_SETTINGS,

      updateSetting: (key, value) => {
        set({ [key]: value });

        // Apply font size to document root
        if (key === 'fontSize') {
          applyFontSize(value as FontSize);
        }

        // Apply list density to document root
        if (key === 'listDensity') {
          applyListDensity(value as ListDensity);
        }

        // Apply animations to document root
        if (key === 'animationsEnabled') {
          applyAnimations(value as boolean);
        }
      },

      resetToDefaults: () => {
        set(DEFAULT_SETTINGS);
        applyFontSize(DEFAULT_SETTINGS.fontSize);
        applyListDensity(DEFAULT_SETTINGS.listDensity);
        applyAnimations(DEFAULT_SETTINGS.animationsEnabled);
      },

      exportSettings: () => {
        const state = get();
        const settings = {
          fontSize: state.fontSize,
          listDensity: state.listDensity,
          animationsEnabled: state.animationsEnabled,
          dateFormat: state.dateFormat,
          timeFormat: state.timeFormat,
          firstDayOfWeek: state.firstDayOfWeek,
          markAsReadDelay: state.markAsReadDelay,
          deleteAction: state.deleteAction,
          showPreview: state.showPreview,
          emailsPerPage: state.emailsPerPage,
          externalContentPolicy: state.externalContentPolicy,
          trustedSenders: state.trustedSenders,
          autoSaveDraftInterval: state.autoSaveDraftInterval,
          sendConfirmation: state.sendConfirmation,
          defaultReplyMode: state.defaultReplyMode,
          sessionTimeout: state.sessionTimeout,
          calendarNotificationsEnabled: state.calendarNotificationsEnabled,
          calendarNotificationSound: state.calendarNotificationSound,
          senderFavicons: state.senderFavicons,
          folderIcons: state.folderIcons,
          debugMode: state.debugMode,
        };
        return JSON.stringify(settings, null, 2);
      },

      importSettings: (json: string) => {
        try {
          const settings = JSON.parse(json);

          // Validate settings
          if (typeof settings !== 'object' || settings === null) {
            return false;
          }

          // Apply settings
          Object.keys(settings).forEach((key) => {
            if (key in DEFAULT_SETTINGS) {
              set({ [key]: settings[key] });
            }
          });

          // Apply visual settings
          applyFontSize(get().fontSize);
          applyListDensity(get().listDensity);
          applyAnimations(get().animationsEnabled);

          return true;
        } catch (error) {
          console.error('Failed to import settings:', error);
          return false;
        }
      },

      // Folder icon methods
      setFolderIcon: (mailboxId: string, icon: string) => {
        set({ folderIcons: { ...get().folderIcons, [mailboxId]: icon } });
      },

      removeFolderIcon: (mailboxId: string) => {
        const { [mailboxId]: _, ...rest } = get().folderIcons;
        set({ folderIcons: rest });
      },

      // Trusted senders methods
      addTrustedSender: (email: string) => {
        const normalizedEmail = email.toLowerCase().trim();
        const current = get().trustedSenders;
        if (!current.includes(normalizedEmail)) {
          set({ trustedSenders: [...current, normalizedEmail] });
        }
      },

      removeTrustedSender: (email: string) => {
        const normalizedEmail = email.toLowerCase().trim();
        set({
          trustedSenders: get().trustedSenders.filter(e => e !== normalizedEmail)
        });
      },

      isSenderTrusted: (email: string) => {
        const normalizedEmail = email.toLowerCase().trim();
        return get().trustedSenders.includes(normalizedEmail);
      },

      // Settings sync methods
      enableSync: (username: string, serverUrl: string) => {
        syncUsername = username;
        syncServerUrl = serverUrl;
        syncEnabled = true;
      },

      disableSync: () => {
        syncEnabled = false;
        syncUsername = null;
        syncServerUrl = null;
        if (syncTimeout) {
          clearTimeout(syncTimeout);
          syncTimeout = null;
        }
      },

      loadFromServer: async (username: string, serverUrl: string) => {
        try {
          const res = await fetch('/api/settings', {
            headers: {
              'x-settings-username': username,
              'x-settings-server': serverUrl,
            },
          });
          if (!res.ok) return false;
          const { settings } = await res.json();
          if (settings && typeof settings === 'object') {
            isLoadingFromServer = true;
            get().importSettings(JSON.stringify(settings));
            isLoadingFromServer = false;
            return true;
          }
          return false;
        } catch {
          isLoadingFromServer = false;
          return false;
        }
      },
    }),
    {
      name: 'settings-storage',
      version: 1,
    }
  )
);

// Helper functions to apply settings to DOM
function applyFontSize(size: FontSize) {
  if (typeof document === 'undefined') return;

  const root = document.documentElement;
  const sizeMap = {
    small: '14px',
    medium: '16px',
    large: '18px',
  };
  root.style.setProperty('--font-size-base', sizeMap[size]);
}

function applyListDensity(density: ListDensity) {
  if (typeof document === 'undefined') return;

  const root = document.documentElement;
  const densityMap = {
    compact: '32px',
    regular: '48px',
    comfortable: '64px',
  };
  root.style.setProperty('--list-item-height', densityMap[density]);
}

function applyAnimations(enabled: boolean) {
  if (typeof document === 'undefined') return;

  const root = document.documentElement;
  if (enabled) {
    root.style.removeProperty('--transition-duration');
  } else {
    root.style.setProperty('--transition-duration', '0s');
  }
}

// Initialize settings on load
if (typeof window !== 'undefined') {
  const store = useSettingsStore.getState();
  applyFontSize(store.fontSize);
  applyListDensity(store.listDensity);
  applyAnimations(store.animationsEnabled);

  // Auto-sync settings to server on any state change
  useSettingsStore.subscribe(() => {
    if (!syncEnabled || !syncUsername || !syncServerUrl || isLoadingFromServer) return;
    if (syncTimeout) clearTimeout(syncTimeout);
    syncTimeout = setTimeout(async () => {
      try {
        const settings = JSON.parse(useSettingsStore.getState().exportSettings());
        const res = await fetch('/api/settings', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: syncUsername, serverUrl: syncServerUrl, settings }),
        });
        if (res.status === 404) {
          syncEnabled = false;
        }
      } catch {
        // Silently ignore sync failures
      }
    }, SYNC_DEBOUNCE_MS);
  });
}
