import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { ComposerDraftData } from '@/components/email/email-composer';

export type ProTabKind =
  | 'mail' | 'calendar' | 'contacts' | 'files' | 'settings'
  | 'compose' | 'email';

export type ProComposerMode = 'compose' | 'reply' | 'replyAll' | 'forward';

/**
 * Mirror of `EmailComposer.replyTo` — kept as a structural type here so the
 * tab store doesn't take a runtime dependency on the composer module.
 */
export interface ProReplyContext {
  from?: { email?: string; name?: string }[];
  replyToAddresses?: { email?: string; name?: string }[];
  to?: { email?: string; name?: string }[];
  cc?: { email?: string; name?: string }[];
  bcc?: { email?: string; name?: string }[];
  subject?: string;
  body?: string;
  htmlBody?: string;
  receivedAt?: string;
  accountId?: string;
  attachments?: Array<{
    blobId: string; name?: string; type: string; size: number;
    cid?: string; disposition?: string;
  }>;
  messageId?: string;
  inReplyTo?: string[];
  references?: string[];
  quoteHeaderHtml?: string;
  quoteHeaderText?: string;
  quoteWrapInBlockquote?: boolean;
}

export interface ProComposeTabData {
  /** Stable session id; used by the composer for draft autosave keying. */
  sessionId: number;
  mode: ProComposerMode;
  replyTo?: ProReplyContext;
  initialDraftText?: string;
  initialData?: ComposerDraftData | null;
  /** The id of the source email when replying/forwarding (for $answered/$forwarded). */
  sourceEmailId?: string | null;
  /** Tab title derived on open; updated as the composer subject changes. */
  title: string;
}

export interface ProEmailTabData {
  accountId: string;
  emailId: string;
  mailboxId: string | null;
  title: string;
}

export interface ProTab {
  id: string;
  kind: ProTabKind;
  /** i18n key under `sidebar.*` for built-in app tabs. Empty for compose/email. */
  labelKey: string;
  /** Dynamic title for compose/email tabs (overrides labelKey when present). */
  title?: string;
  closeable: boolean;
  composeData?: ProComposeTabData;
  emailData?: ProEmailTabData;
}

interface ProTabState {
  tabs: ProTab[];
  activeTabId: string;
  loadedTabIds: string[];

  openTab: (kind: 'mail' | 'calendar' | 'contacts' | 'files' | 'settings') => string;
  openComposeTab: (data: ProComposeTabData) => string;
  openEmailTab: (data: ProEmailTabData) => string;
  closeTab: (id: string) => void;
  setActiveTab: (id: string) => void;
  moveTab: (fromIdx: number, toIdx: number) => void;
  /** Update the dynamic title of a tab (used by compose tabs as the subject changes). */
  updateTabTitle: (id: string, title: string) => void;
  /** Persist updated draft state for a compose tab — used by the composer's onSaveState. */
  updateComposeDraft: (id: string, draft: ComposerDraftData) => void;
}

const TAB_BLUEPRINTS: Record<'mail' | 'calendar' | 'contacts' | 'files' | 'settings', { labelKey: string }> = {
  mail:     { labelKey: 'mail' },
  calendar: { labelKey: 'calendar' },
  contacts: { labelKey: 'contacts' },
  files:    { labelKey: 'files' },
  settings: { labelKey: 'settings' },
};

const HOME_TAB: ProTab = {
  id: 'home-mail',
  kind: 'mail',
  labelKey: TAB_BLUEPRINTS.mail.labelKey,
  closeable: false,
};

function makeId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `pro-tab-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

export const useProTabStore = create<ProTabState>()(
  persist(
    (set, get) => ({
      tabs: [HOME_TAB],
      activeTabId: HOME_TAB.id,
      loadedTabIds: [HOME_TAB.id],

      openTab: (kind) => {
        const state = get();
        const existing = state.tabs.find((tab) => tab.kind === kind);
        if (existing) {
          if (state.activeTabId !== existing.id) {
            set({
              activeTabId: existing.id,
              loadedTabIds: state.loadedTabIds.includes(existing.id)
                ? state.loadedTabIds
                : [...state.loadedTabIds, existing.id],
            });
          }
          return existing.id;
        }
        const blueprint = TAB_BLUEPRINTS[kind];
        const newTab: ProTab = {
          id: makeId(),
          kind,
          labelKey: blueprint.labelKey,
          closeable: true,
        };
        set({
          tabs: [...state.tabs, newTab],
          activeTabId: newTab.id,
          loadedTabIds: [...state.loadedTabIds, newTab.id],
        });
        return newTab.id;
      },

      openComposeTab: (data) => {
        const state = get();
        const newTab: ProTab = {
          id: makeId(),
          kind: 'compose',
          labelKey: '',
          title: data.title,
          closeable: true,
          composeData: data,
        };
        set({
          tabs: [...state.tabs, newTab],
          activeTabId: newTab.id,
          loadedTabIds: [...state.loadedTabIds, newTab.id],
        });
        return newTab.id;
      },

      openEmailTab: (data) => {
        const state = get();
        // Focus an existing email tab for the same message instead of duplicating.
        const existing = state.tabs.find(
          (tab) => tab.kind === 'email'
            && tab.emailData?.emailId === data.emailId
            && tab.emailData?.accountId === data.accountId
        );
        if (existing) {
          if (state.activeTabId !== existing.id) {
            set({
              activeTabId: existing.id,
              loadedTabIds: state.loadedTabIds.includes(existing.id)
                ? state.loadedTabIds
                : [...state.loadedTabIds, existing.id],
            });
          }
          return existing.id;
        }
        const newTab: ProTab = {
          id: makeId(),
          kind: 'email',
          labelKey: '',
          title: data.title,
          closeable: true,
          emailData: data,
        };
        set({
          tabs: [...state.tabs, newTab],
          activeTabId: newTab.id,
          loadedTabIds: [...state.loadedTabIds, newTab.id],
        });
        return newTab.id;
      },

      closeTab: (id) => {
        const state = get();
        const tab = state.tabs.find((t) => t.id === id);
        if (!tab || !tab.closeable) return;

        const idx = state.tabs.findIndex((t) => t.id === id);
        const newTabs = state.tabs.filter((t) => t.id !== id);
        const newLoaded = state.loadedTabIds.filter((tid) => tid !== id);

        let newActive = state.activeTabId;
        if (state.activeTabId === id) {
          const neighbor = newTabs[idx] ?? newTabs[idx - 1] ?? newTabs[0];
          newActive = neighbor?.id ?? HOME_TAB.id;
        }

        if (newTabs.length === 0) {
          set({
            tabs: [HOME_TAB],
            activeTabId: HOME_TAB.id,
            loadedTabIds: [HOME_TAB.id],
          });
          return;
        }

        set({
          tabs: newTabs,
          activeTabId: newActive,
          loadedTabIds: newLoaded.includes(newActive) ? newLoaded : [...newLoaded, newActive],
        });
      },

      setActiveTab: (id) => {
        const state = get();
        if (!state.tabs.some((t) => t.id === id)) return;
        if (state.activeTabId === id) return;
        set({
          activeTabId: id,
          loadedTabIds: state.loadedTabIds.includes(id)
            ? state.loadedTabIds
            : [...state.loadedTabIds, id],
        });
      },

      moveTab: (fromIdx, toIdx) => {
        const state = get();
        if (fromIdx === toIdx) return;
        if (fromIdx < 0 || fromIdx >= state.tabs.length) return;
        if (toIdx < 0 || toIdx >= state.tabs.length) return;
        const tabs = [...state.tabs];
        const [moved] = tabs.splice(fromIdx, 1);
        tabs.splice(toIdx, 0, moved);
        set({ tabs });
      },

      updateTabTitle: (id, title) => {
        const state = get();
        const tabs = state.tabs.map((tab) =>
          tab.id === id ? { ...tab, title } : tab
        );
        set({ tabs });
      },

      updateComposeDraft: (id, draft) => {
        const state = get();
        const tabs = state.tabs.map((tab) => {
          if (tab.id !== id || tab.kind !== 'compose' || !tab.composeData) return tab;
          return {
            ...tab,
            composeData: { ...tab.composeData, initialData: draft },
          };
        });
        set({ tabs });
      },
    }),
    {
      name: 'pro-tabs',
      version: 2,
      // Don't persist transient compose drafts in tab metadata — the composer's
      // own draft-store already handles that. Persisted email tabs are fine to
      // restore (the tab body refetches the email by id).
      partialize: (state) => ({
        tabs: state.tabs.map((tab) =>
          tab.kind === 'compose'
            ? { ...tab, composeData: undefined } // drop compose tabs on reload
            : tab
        ).filter((tab) => tab.kind !== 'compose'),
        activeTabId: state.activeTabId,
        loadedTabIds: state.loadedTabIds,
      }),
      onRehydrateStorage: () => (state) => {
        if (!state) return;
        if (state.tabs.length === 0) {
          state.tabs = [HOME_TAB];
          state.activeTabId = HOME_TAB.id;
          state.loadedTabIds = [HOME_TAB.id];
          return;
        }
        if (!state.tabs.some((t) => t.id === state.activeTabId)) {
          state.activeTabId = state.tabs[0].id;
        }
        if (!state.loadedTabIds.includes(state.activeTabId)) {
          state.loadedTabIds = [...state.loadedTabIds, state.activeTabId];
        }
      },
    },
  ),
);
