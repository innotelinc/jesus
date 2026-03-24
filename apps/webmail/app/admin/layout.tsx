'use client';

import { useEffect, useState } from 'react';
import { useRouter, usePathname } from 'next/navigation';
import Link from 'next/link';
import {
  LayoutDashboard,
  Settings,
  Palette,
  Shield,
  Scale,
  ScrollText,
  LogOut,
  KeyRound,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { useConfig } from '@/hooks/use-config';
import { useThemeStore } from '@/stores/theme-store';

const NAV_ITEMS = [
  { href: '/admin', label: 'Dashboard', icon: LayoutDashboard },
  { href: '/admin/settings', label: 'Settings', icon: Settings },
  { href: '/admin/branding', label: 'Branding', icon: Palette },
  { href: '/admin/auth', label: 'Authentication', icon: Shield },
  { href: '/admin/policy', label: 'Policy', icon: Scale },
  { href: '/admin/logs', label: 'Audit Log', icon: ScrollText },
];

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const [authenticated, setAuthenticated] = useState<boolean | null>(null);
  const { appLogoLightUrl, appLogoDarkUrl, loginLogoLightUrl, loginLogoDarkUrl } = useConfig();
  const resolvedTheme = useThemeStore((s) => s.resolvedTheme);
  const logoUrl = resolvedTheme === 'dark'
    ? (appLogoDarkUrl || appLogoLightUrl || loginLogoDarkUrl)
    : (appLogoLightUrl || appLogoDarkUrl || loginLogoLightUrl);

  useEffect(() => {
    checkAuth();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function checkAuth() {
    try {
      const res = await fetch('/api/admin/auth');
      const data = await res.json();
      if (!data.enabled) {
        router.replace('/');
        return;
      }
      if (!data.authenticated) {
        router.replace('/admin/login');
        return;
      }
      setAuthenticated(true);
    } catch {
      router.replace('/admin/login');
    }
  }

  async function handleLogout() {
    await fetch('/api/admin/auth', { method: 'DELETE' });
    router.replace('/admin/login');
  }

  // Don't gate the login page
  if (pathname === '/admin/login') {
    return <>{children}</>;
  }

  if (authenticated === null) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="animate-pulse text-muted-foreground text-sm">Loading...</div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex bg-background">
      {/* Sidebar */}
      <aside className="w-60 border-r border-border bg-secondary/30 flex flex-col">
        <div className="h-14 flex items-center px-4 border-b border-border">
          {logoUrl ? (
            <img src={logoUrl} alt="" className="w-5 h-5 object-contain mr-2" />
          ) : (
            <Shield className="w-5 h-5 text-primary mr-2" />
          )}
          <span className="font-semibold text-sm text-foreground">Admin Panel</span>
        </div>

        <nav className="flex-1 py-2 px-2 space-y-0.5">
          {NAV_ITEMS.map(({ href, label, icon: Icon }) => {
            const active = href === '/admin' ? pathname === '/admin' : pathname.startsWith(href);
            return (
              <Link
                key={href}
                href={href}
                className={cn(
                  'flex items-center gap-2.5 px-3 py-2 rounded-md text-sm transition-colors',
                  active
                    ? 'bg-accent text-accent-foreground font-medium'
                    : 'text-muted-foreground hover:text-foreground hover:bg-accent/50'
                )}
              >
                <Icon className="w-4 h-4" />
                {label}
              </Link>
            );
          })}
        </nav>

        <div className="p-2 border-t border-border space-y-0.5">
          <Link
            href="/admin/change-password"
            className="flex items-center gap-2.5 px-3 py-2 rounded-md text-sm text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors"
          >
            <KeyRound className="w-4 h-4" />
            Change Password
          </Link>
          <button
            onClick={handleLogout}
            className="flex items-center gap-2.5 px-3 py-2 rounded-md text-sm text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors w-full text-left"
          >
            <LogOut className="w-4 h-4" />
            Sign out
          </button>
        </div>
      </aside>

      {/* Main content */}
      <main className="flex-1 overflow-auto">
        <div className="max-w-4xl mx-auto p-6">
          {children}
        </div>
      </main>
    </div>
  );
}
