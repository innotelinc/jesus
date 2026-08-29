import { create } from "zustand";
import type { IJMAPClient } from "@/lib/jmap/client-interface";
import type { ShareNotification } from "@/lib/jmap/types";

/**
 * ShareNotification (RFC 9670 §3) inbox: the server records every change to
 * this user's rights on someone else's collection. The store pulls those on
 * login and on every `ShareNotification` push; the toaster component shows
 * them (translated) and acknowledges them, which destroys them server-side.
 */
interface ShareNotificationStore {
  /** Notifications fetched but not yet shown / acknowledged. */
  pending: ShareNotification[];
  fetch: (client: IJMAPClient) => Promise<void>;
  /** Acknowledge shown notifications: drop them locally and destroy them on the server. */
  acknowledge: (client: IJMAPClient, ids: string[]) => Promise<void>;
  reset: () => void;
}

// Ids already handed to the toaster; a fetch racing an acknowledge must not
// re-queue them.
const seen = new Set<string>();
let inFlight: Promise<void> | null = null;

export const useShareNotificationStore = create<ShareNotificationStore>((set, get) => ({
  pending: [],

  fetch: (client) => {
    if (!client.supportsShareNotifications?.() || !client.getShareNotifications) return Promise.resolve();
    // Coalesce: a push arriving while the previous fetch runs re-runs it once.
    if (inFlight) return inFlight;
    inFlight = (async () => {
      try {
        const list = await client.getShareNotifications!();
        const fresh = list.filter((n) => !seen.has(n.id));
        if (fresh.length === 0) return;
        for (const n of fresh) seen.add(n.id);
        set((state) => ({ pending: [...state.pending, ...fresh] }));
      } catch (error) {
        console.error("Failed to fetch share notifications:", error);
      } finally {
        inFlight = null;
      }
    })();
    return inFlight;
  },

  acknowledge: async (client, ids) => {
    if (ids.length === 0) return;
    const idSet = new Set(ids);
    set({ pending: get().pending.filter((n) => !idSet.has(n.id)) });
    try {
      await client.destroyShareNotifications?.(ids);
    } catch (error) {
      // Worst case the notification is shown again after a reload.
      console.error("Failed to acknowledge share notifications:", error);
    }
  },

  reset: () => {
    seen.clear();
    set({ pending: [] });
  },
}));
