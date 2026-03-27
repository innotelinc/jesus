import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { InstalledTheme, ThemeVariant } from '@/lib/plugin-types';
import { pluginStorage } from '@/lib/plugin-storage';
import { injectThemeCSS, removeThemeCSS, sanitizeThemeCSS } from '@/lib/theme-loader';
import { extractTheme } from '@/lib/plugin-validator';
import { BUILTIN_THEMES } from '@/lib/builtin-themes';
import { usePolicyStore } from '@/stores/policy-store';

type Theme = 'light' | 'dark' | 'system';

interface ThemeState {
  theme: Theme;
  resolvedTheme: 'light' | 'dark';
  hydrated: boolean;

  // Custom theme system
  installedThemes: InstalledTheme[];
  activeThemeId: string | null; // null = built-in default

  setTheme: (theme: Theme) => void;
  toggleTheme: () => void;
  initializeTheme: () => void;

  // Custom theme management
  installTheme: (file: File) => Promise<{ success: boolean; error?: string; warnings?: string[] }>;
  uninstallTheme: (id: string) => void;
  activateTheme: (id: string | null) => void;
  syncServerThemes: () => Promise<void>;
}

const getSystemTheme = (): 'light' | 'dark' => {
  if (typeof window === 'undefined') return 'light';
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
};

const applyTheme = (theme: 'light' | 'dark') => {
  if (typeof document === 'undefined') return;

  const root = document.documentElement;
  if (theme === 'dark') {
    root.classList.remove('light');
    root.classList.add('dark');
  } else {
    root.classList.remove('dark');
    root.classList.add('light');
  }

  // Also update color-scheme for native elements (scrollbars, form controls)
  root.style.colorScheme = theme;

  localStorage.setItem('theme-applied', theme);
};

let mediaQueryCleanup: (() => void) | null = null;
let themeSyncPromise: Promise<void> | null = null;

export const useThemeStore = create<ThemeState>()(
  persist(
    (set, get) => ({
      theme: 'system',
      resolvedTheme: 'light',
      hydrated: false,
      installedThemes: [...BUILTIN_THEMES],
      activeThemeId: null,

      setTheme: (theme) => {
        const resolvedTheme = theme === 'system' ? getSystemTheme() : theme;
        applyTheme(resolvedTheme);
        set({ theme, resolvedTheme });
        // Re-apply active custom theme for new mode
        const { activeThemeId, installedThemes } = get();
        if (activeThemeId) {
          const t = installedThemes.find(t => t.id === activeThemeId);
          if (t) applyCustomThemeCSS(t, resolvedTheme);
        }
      },

      toggleTheme: () => {
        const { theme } = get();
        const nextTheme: Theme =
          theme === 'light' ? 'dark' :
          theme === 'dark' ? 'system' : 'light';
        get().setTheme(nextTheme);
      },

      initializeTheme: () => {
        const { theme, activeThemeId, installedThemes } = get();
        const resolvedTheme = theme === 'system' ? getSystemTheme() : theme;
        applyTheme(resolvedTheme);
        set({ resolvedTheme, hydrated: true });

        // Determine effective theme: user choice > policy default > none
        let effectiveThemeId = activeThemeId;
        if (!effectiveThemeId) {
          const policyState = usePolicyStore.getState();
          const tp = policyState.policy.themePolicy;
          if (tp?.defaultThemeId) {
            effectiveThemeId = tp.defaultThemeId;
            // Persist so we don't re-check every time
            set({ activeThemeId: effectiveThemeId });
          }
        }

        // Apply active custom theme on boot
        if (effectiveThemeId) {
          const t = installedThemes.find(t => t.id === effectiveThemeId);
          if (t) {
            // Load CSS from IndexedDB (may have been stripped from localStorage)
            if (t.css) {
              applyCustomThemeCSS(t, resolvedTheme);
            } else {
              pluginStorage.getThemeCSS(effectiveThemeId).then(css => {
                if (css) {
                  injectThemeCSS(css);
                  // Update the in-memory cache
                  set({
                    installedThemes: installedThemes.map(
                      it => it.id === effectiveThemeId ? { ...it, css } : it
                    ),
                  });
                }
              });
            }
          }
        }

        // Clean up previous listener if any
        if (mediaQueryCleanup) {
          mediaQueryCleanup();
          mediaQueryCleanup = null;
        }

        if (typeof window !== 'undefined') {
          const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
          const handleChange = () => {
            const { theme, activeThemeId, installedThemes } = get();
            if (theme === 'system') {
              const newResolvedTheme = getSystemTheme();
              applyTheme(newResolvedTheme);
              set({ resolvedTheme: newResolvedTheme });
              if (activeThemeId) {
                const t = installedThemes.find(t => t.id === activeThemeId);
                if (t) applyCustomThemeCSS(t, newResolvedTheme);
              }
            }
          };

          mediaQuery.addEventListener('change', handleChange);
          mediaQueryCleanup = () => mediaQuery.removeEventListener('change', handleChange);
        }
      },

      installTheme: async (file: File) => {
        const result = await extractTheme(file);
        if (!result.valid || !result.manifest) {
          return { success: false, error: result.errors.join('; '), warnings: result.warnings };
        }

        const { manifest, css, preview } = result;
        const { installedThemes } = get();

        // Check for duplicate
        if (installedThemes.some(t => t.id === manifest.id)) {
          // Update existing
          const sanitized = sanitizeThemeCSS(css);
          const theme: InstalledTheme = {
            id: manifest.id,
            name: manifest.name,
            version: manifest.version,
            author: manifest.author,
            description: manifest.description || '',
            preview: preview || undefined,
            css: sanitized.css,
            variants: manifest.variants,
            enabled: true,
            builtIn: false,
          };

          await pluginStorage.saveThemeCSS(manifest.id, sanitized.css);
          if (preview) await pluginStorage.savePreview(manifest.id, preview);

          set({
            installedThemes: installedThemes.map(t =>
              t.id === manifest.id ? theme : t
            ),
          });

          return { success: true, warnings: [...result.warnings, ...sanitized.warnings] };
        }

        // Install new
        const sanitized = sanitizeThemeCSS(css);
        const theme: InstalledTheme = {
          id: manifest.id,
          name: manifest.name,
          version: manifest.version,
          author: manifest.author,
          description: manifest.description || '',
          preview: preview || undefined,
          css: sanitized.css,
          variants: manifest.variants,
          enabled: true,
          builtIn: false,
        };

        await pluginStorage.saveThemeCSS(manifest.id, sanitized.css);
        if (preview) await pluginStorage.savePreview(manifest.id, preview);

        set({ installedThemes: [...installedThemes, theme] });
        return { success: true, warnings: [...result.warnings, ...sanitized.warnings] };
      },

      uninstallTheme: (id: string) => {
        const { installedThemes, activeThemeId } = get();
        const theme = installedThemes.find(t => t.id === id);
        if (!theme || theme.builtIn) return;

        // Deactivate if active
        if (activeThemeId === id) {
          removeThemeCSS();
          set({ activeThemeId: null });
        }

        // Clean up storage
        pluginStorage.deleteThemeCSS(id);
        pluginStorage.deletePreview(id);

        set({
          installedThemes: installedThemes.filter(t => t.id !== id),
        });
      },

      activateTheme: (id: string | null) => {
        if (id === null) {
          removeThemeCSS();
          set({ activeThemeId: null });
          return;
        }

        const { installedThemes, resolvedTheme } = get();
        const theme = installedThemes.find(t => t.id === id);
        if (!theme) return;

        applyCustomThemeCSS(theme, resolvedTheme);
        set({ activeThemeId: id });
      },

      syncServerThemes: async () => {
        if (themeSyncPromise) {
          await themeSyncPromise;
          return;
        }

        themeSyncPromise = (async () => {
          try {
            const res = await fetch('/api/plugins');
            if (!res.ok) return;

            const data: { themes: ServerThemeInfo[] } = await res.json();
            if (!data.themes || !Array.isArray(data.themes)) return;

            const serverThemes = data.themes;

            for (const st of serverThemes) {
              const local = get().installedThemes.find(t => t.id === st.id);

              if (!local) {
                // Download and install new server theme
                const css = await downloadThemeCSS(st.id);
                if (!css) continue;

                const sanitized = sanitizeThemeCSS(css);
                const theme: InstalledTheme = {
                  id: st.id,
                  name: st.name,
                  version: st.version,
                  author: st.author,
                  description: st.description || '',
                  css: sanitized.css,
                  variants: st.variants as ThemeVariant[],
                  enabled: true,
                  builtIn: false,
                };

                await pluginStorage.saveThemeCSS(st.id, sanitized.css);
                set(state => {
                  if (state.installedThemes.some(t => t.id === st.id)) {
                    return {};
                  }
                  return {
                    installedThemes: [...state.installedThemes, theme],
                  };
                });

                // If this is force-enabled and no theme is active, activate it
                if (st.forceEnabled && !get().activeThemeId) {
                  applyCustomThemeCSS(theme, get().resolvedTheme);
                  set({ activeThemeId: st.id });
                }
              } else if (!local.builtIn && local.version !== st.version) {
                // Version changed — re-download CSS
                const css = await downloadThemeCSS(st.id);
                if (!css) continue;

                const sanitized = sanitizeThemeCSS(css);
                await pluginStorage.saveThemeCSS(st.id, sanitized.css);

                const updatedTheme = {
                  ...local,
                  name: st.name,
                  version: st.version,
                  author: st.author,
                  description: st.description || '',
                  css: sanitized.css,
                  variants: st.variants as ThemeVariant[],
                };

                set(state => ({
                  installedThemes: state.installedThemes.map(t =>
                    t.id === st.id ? updatedTheme : t
                  ),
                }));

                // Re-apply if active
                if (get().activeThemeId === st.id) {
                  applyCustomThemeCSS(updatedTheme, get().resolvedTheme);
                }
              }
            }

            set(state => ({
              installedThemes: dedupeInstalledThemes(state.installedThemes),
            }));
          } catch {
            console.warn('[theme-store] Server theme sync failed');
          }
        })();

        try {
          await themeSyncPromise;
        } finally {
          themeSyncPromise = null;
        }
      },
    }),
    {
      name: 'theme-storage',
      partialize: (state) => ({
        theme: state.theme,
        activeThemeId: state.activeThemeId,
        // Store theme metadata but NOT full CSS (that goes in IndexedDB)
        installedThemes: state.installedThemes.map(t => ({
          ...t,
          css: t.builtIn ? t.css : '', // only keep CSS for built-in themes
          preview: undefined, // previews also in IndexedDB
        })),
      }),
      onRehydrateStorage: () => {
        return (state) => {
          if (state) {
            // Ensure built-in themes are always present after rehydration
            const builtInIds = new Set(BUILTIN_THEMES.map(t => t.id));
            const userThemes = state.installedThemes.filter(t => !builtInIds.has(t.id));
            state.installedThemes = [...BUILTIN_THEMES, ...userThemes];

            // Re-apply theme immediately after rehydration
            const resolvedTheme = state.theme === 'system' ? getSystemTheme() : state.theme;
            applyTheme(resolvedTheme);
            state.resolvedTheme = resolvedTheme;
            state.hydrated = true;
          }
        };
      },
    }
  )
);

/** Apply a custom theme's CSS, filtering to the appropriate variant */
function applyCustomThemeCSS(theme: InstalledTheme, resolvedTheme: 'light' | 'dark'): void {
  // If theme only supports one variant and current mode doesn't match, skip
  if (!theme.variants.includes(resolvedTheme as ThemeVariant)) {
    removeThemeCSS();
    return;
  }
  injectThemeCSS(theme.css);
}

// ─── Server Theme Sync Helpers ───────────────────────────────

interface ServerThemeInfo {
  id: string;
  name: string;
  version: string;
  author: string;
  description: string;
  variants: string[];
  forceEnabled: boolean;
}

function dedupeInstalledThemes(themes: InstalledTheme[]): InstalledTheme[] {
  const byId = new Map<string, InstalledTheme>();

  for (const theme of themes) {
    const existing = byId.get(theme.id);
    if (!existing) {
      byId.set(theme.id, theme);
      continue;
    }

    byId.set(theme.id, {
      ...existing,
      ...theme,
      builtIn: existing.builtIn || theme.builtIn,
      enabled: existing.enabled || theme.enabled,
    });
  }

  return [...byId.values()];
}

async function downloadThemeCSS(themeId: string): Promise<string | null> {
  try {
    const res = await fetch(`/api/admin/themes/${encodeURIComponent(themeId)}/css`);
    if (!res.ok) return null;
    return await res.text();
  } catch {
    console.warn(`[theme-store] Failed to download CSS for theme "${themeId}"`);
    return null;
  }
}