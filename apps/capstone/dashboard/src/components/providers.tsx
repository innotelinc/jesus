import { useState, useEffect, useCallback, type ReactNode } from 'react';
import { createContext, useContext, useRef } from 'react';

type Theme = 'dark' | 'light';

interface ThemeContextValue {
  theme: Theme;
  setTheme: (theme: Theme) => void;
  resolvedTheme: Theme;
}

const ThemeContext = createContext<ThemeContextValue | undefined>(undefined);

function getPreferredTheme(): Theme {
  if (typeof window === 'undefined') return 'dark';
  const stored = localStorage.getItem('theme');
  if (stored === 'dark' || stored === 'light') return stored as Theme;
  if (window.matchMedia('(prefers-color-scheme: dark)').matches) return 'dark';
  return 'light';
}

function applyThemeClass(theme: Theme) {
  const root = document.documentElement;
  if (theme === 'dark') {
    root.classList.add('dark');
    root.classList.remove('light');
  } else {
    root.classList.add('light');
    root.classList.remove('dark');
  }
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setTheme] = useState<Theme>(getPreferredTheme);
  const [resolvedTheme, setResolvedTheme] = useState<Theme>(theme);
  const mountedRef = useRef(false);
  const mediaQueryRef = useRef<MediaQueryList | null>(null);

  useEffect(() => {
    applyThemeClass(theme);
    try {
      localStorage.setItem('theme', theme);
    } catch {
      // noop
    }
    setResolvedTheme(theme);
  }, [theme]);

  useEffect(() => {
    mountedRef.current = true;
    const mql = window.matchMedia('(prefers-color-scheme: dark)');

    const listener = (e: MediaQueryListEvent) => {
      if (!localStorage.getItem('theme')) {
        const next = e.matches ? 'dark' : 'light';
        if (mountedRef.current) setTheme(next);
      }
    };

    mql.addEventListener('change', listener);
    mediaQueryRef.current = mql;

    return () => {
      mql.removeEventListener('change', listener);
    };
  }, []);

  // Listen for external theme changes from other tabs
  useEffect(() => {
    function handleStorage(e: StorageEvent) {
      if (e.key === 'theme' && e.newValue && mountedRef.current) {
        const next = e.newValue as Theme;
        if (next === 'dark' || next === 'light') {
          setTheme(next);
        }
      }
    }
    window.addEventListener('storage', handleStorage);
    return () => window.removeEventListener('storage', handleStorage);
  }, []);

  const value = {
    theme,
    setTheme: useCallback((t: Theme) => {
      if (t !== theme) setTheme(t);
    }, [theme]),
    resolvedTheme,
  };

  return (
    <ThemeContext.Provider value={value}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be used within ThemeProvider');
  return ctx;
}

export function useResolvedTheme() {
  return useTheme();
}
