// Plugin store — manages installed plugins, slot registrations, and lifecycle

import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type {
  InstalledPlugin,
  PluginStatus,
  SlotName,
  SlotRegistration,
  Disposable,
} from '@/lib/plugin-types';
import { pluginStorage } from '@/lib/plugin-storage';
import { extractPlugin } from '@/lib/plugin-validator';
import { loadPlugin, deactivatePlugin, setPluginStoreAccessor, setupAutoDisable } from '@/lib/plugin-loader';
import { setSlotRegistrationBridge } from '@/lib/plugin-api';
import { removeAllPluginHooks } from '@/lib/plugin-hooks';

// ─── Slot State ──────────────────────────────────────────────

const SLOT_NAMES: SlotName[] = [
  'toolbar-actions', 'email-banner', 'email-footer', 'composer-toolbar',
  'sidebar-widget', 'settings-section', 'context-menu-email', 'navigation-rail-bottom',
];

function emptySlots(): Record<SlotName, SlotRegistration[]> {
  const slots = {} as Record<SlotName, SlotRegistration[]>;
  for (const name of SLOT_NAMES) {
    slots[name] = [];
  }
  return slots;
}

// ─── Store Interface ─────────────────────────────────────────

interface PluginStoreState {
  plugins: InstalledPlugin[];
  slots: Record<SlotName, SlotRegistration[]>;
  initialized: boolean;

  // Management
  installPlugin: (file: File) => Promise<{ success: boolean; error?: string; warnings?: string[] }>;
  uninstallPlugin: (id: string) => void;
  enablePlugin: (id: string) => Promise<void>;
  disablePlugin: (id: string) => void;
  updatePluginSettings: (id: string, settings: Record<string, unknown>) => void;

  // Runtime (called by plugin loader / API bridge)
  registerSlot: (slotName: SlotName, registration: SlotRegistration) => Disposable;
  setPluginStatus: (id: string, status: PluginStatus, error?: string) => void;

  // Init
  initializePlugins: () => Promise<void>;
}

// ─── Store ───────────────────────────────────────────────────

export const usePluginStore = create<PluginStoreState>()(
  persist(
    (set, get) => ({
      plugins: [],
      slots: emptySlots(),
      initialized: false,

      installPlugin: async (file: File) => {
        const result = await extractPlugin(file);
        if (!result.valid || !result.manifest) {
          return { success: false, error: result.errors.join('; '), warnings: result.warnings };
        }

        const { manifest, code } = result;
        const { plugins } = get();

        // Check for duplicate
        const existing = plugins.find(p => p.id === manifest.id);
        if (existing) {
          // Update: deactivate old, replace
          deactivatePlugin(manifest.id);
        }

        const plugin: InstalledPlugin = {
          id: manifest.id,
          name: manifest.name,
          version: manifest.version,
          author: manifest.author,
          description: manifest.description,
          type: manifest.type,
          permissions: manifest.permissions,
          entrypoint: manifest.entrypoint,
          enabled: false, // Start disabled, user must enable
          status: 'installed',
          settings: existing?.settings ?? {},
          settingsSchema: manifest.settingsSchema,
        };

        // Save code to IndexedDB
        await pluginStorage.saveCode(manifest.id, code);

        if (existing) {
          set({ plugins: plugins.map(p => p.id === manifest.id ? plugin : p) });
        } else {
          set({ plugins: [...plugins, plugin] });
        }

        return { success: true, warnings: result.warnings };
      },

      uninstallPlugin: (id: string) => {
        const { plugins } = get();
        const plugin = plugins.find(p => p.id === id);
        if (!plugin) return;

        // Deactivate if running
        deactivatePlugin(id);
        removeAllPluginHooks(id);

        // Clean up storage
        pluginStorage.deleteCode(id);
        pluginStorage.deletePreview(id);

        // Remove plugin-scoped localStorage entries
        if (typeof window !== 'undefined') {
          const prefix = `plugin:${id}:`;
          const keysToRemove: string[] = [];
          for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            if (key?.startsWith(prefix)) keysToRemove.push(key);
          }
          keysToRemove.forEach(k => localStorage.removeItem(k));
        }

        set({ plugins: plugins.filter(p => p.id !== id) });
      },

      enablePlugin: async (id: string) => {
        const { plugins } = get();
        const plugin = plugins.find(p => p.id === id);
        if (!plugin) return;

        set({
          plugins: plugins.map(p =>
            p.id === id ? { ...p, enabled: true, status: 'enabled' as PluginStatus, error: undefined } : p
          ),
        });

        // Load it immediately
        const updatedPlugin = get().plugins.find(p => p.id === id);
        if (updatedPlugin) {
          await loadPlugin(updatedPlugin);
        }
      },

      disablePlugin: (id: string) => {
        const { plugins } = get();
        deactivatePlugin(id);

        set({
          plugins: plugins.map(p =>
            p.id === id ? { ...p, enabled: false, status: 'disabled' as PluginStatus, error: undefined } : p
          ),
        });
      },

      updatePluginSettings: (id: string, settings: Record<string, unknown>) => {
        const { plugins } = get();
        set({
          plugins: plugins.map(p =>
            p.id === id ? { ...p, settings: { ...p.settings, ...settings } } : p
          ),
        });
      },

      registerSlot: (slotName: SlotName, registration: SlotRegistration): Disposable => {
        set(state => ({
          slots: {
            ...state.slots,
            [slotName]: [
              ...state.slots[slotName],
              registration,
            ].sort((a, b) => a.order - b.order),
          },
        }));

        return {
          dispose: () => {
            set(state => ({
              slots: {
                ...state.slots,
                [slotName]: state.slots[slotName].filter(r => r !== registration),
              },
            }));
          },
        };
      },

      setPluginStatus: (id: string, status: PluginStatus, error?: string) => {
        set(state => ({
          plugins: state.plugins.map(p =>
            p.id === id ? { ...p, status, error } : p
          ),
        }));
      },

      initializePlugins: async () => {
        if (get().initialized) return;

        // Wire up bridges
        setPluginStoreAccessor({
          setPluginStatus: get().setPluginStatus,
        });
        setSlotRegistrationBridge(get().registerSlot);
        setupAutoDisable();

        // Load all enabled plugins
        const enabledPlugins = get().plugins.filter(p => p.enabled && p.status !== 'error');
        for (const plugin of enabledPlugins) {
          await loadPlugin(plugin);
        }

        set({ initialized: true });
      },
    }),
    {
      name: 'plugin-storage',
      partialize: (state) => ({
        plugins: state.plugins.map(p => ({
          ...p,
          // Reset runtime state on persist
          status: p.enabled ? 'enabled' : 'installed',
          error: undefined,
        })),
        // Don't persist slots — they are runtime-only, rebuilt on load
      }),
      onRehydrateStorage: () => {
        return (state) => {
          if (state) {
            // Ensure slots are initialized after rehydration
            state.slots = emptySlots();
            state.initialized = false;
          }
        };
      },
    }
  )
);
