import { useState } from 'react';
import { useResolvedTheme } from './providers';
import { useDashboardData } from '../context/DashboardDataContext';
import { cn } from '../lib/utils';
import type { Environment } from '../types';

const environments: Environment[] = ['dev', 'test', 'stage', 'prod'];

function ThemeToggle() {
  const { theme, setTheme } = useResolvedTheme();
  return (
    <button
      className="inline-flex items-center gap-2 rounded-lg px-3 py-2 text-sm text-muted-foreground transition-colors hover:text-foreground hover:bg-muted"
      onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
      aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}
    >
      {theme === 'dark' ? (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4">
          <circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
        </svg>
      ) : (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4">
          <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
        </svg>
      )}
      <span className="hidden sm:inline">{theme === 'dark' ? 'Dark' : 'Light'}</span>
    </button>
  );
}

function ProfileMenu() {
  const [open, setOpen] = useState(false);
  const { users } = useDashboardData();
  const admin = users.find(u => u.role === 'admin');
  const displayName = admin?.name ?? 'Admin';
  const email = admin?.email ?? 'admin@capstone.internal';
  const initials = displayName
    .split(/[\s._-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map(p => p[0]?.toUpperCase() ?? '')
    .join('') || 'A';
  return (
    <div className="relative">
      <button
        className="flex items-center gap-2 rounded-lg px-2 py-2 text-sm text-muted-foreground transition-colors hover:text-foreground hover:bg-muted"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label="User profile menu"
      >
        <div className="flex h-8 w-8 items-center justify-center rounded-full bg-secondary text-secondary-foreground text-xs font-semibold uppercase">
          {initials}
        </div>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4">
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div
            className="absolute right-0 z-20 mt-2 w-56 rounded-lg border bg-popover p-2 shadow-lg animate-in"
            role="menu"
            aria-label="User profile"
          >
            <div className="flex items-center gap-3 rounded-lg px-3 py-2 text-sm">
              <div className="flex h-9 w-9 items-center justify-center rounded-full bg-secondary text-secondary-foreground text-xs font-semibold uppercase">
                {initials}
              </div>
              <div>
                <div className="font-medium">{displayName}</div>
                <div className="text-xs text-muted-foreground">{email}</div>
              </div>
            </div>
            <div className="mt-2 border-t pt-2" />
            <div className="flex flex-col gap-1 text-sm">
              <button className="flex items-center gap-2 rounded-lg px-3 py-2 text-muted-foreground hover:bg-muted hover:text-foreground transition-colors">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4"><circle cx="12" cy="8" r="4" /><path d="M20 21a8 8 0 1 0-16 0" /></svg>
                Profile
              </button>
              <button className="flex items-center gap-2 rounded-lg px-3 py-2 text-muted-foreground hover:bg-muted hover:text-foreground transition-colors">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" /><circle cx="12" cy="7" r="4" /></svg>
                Account settings
              </button>
              <button className="flex items-center gap-2 rounded-lg px-3 py-2 text-muted-foreground hover:bg-muted hover:text-foreground transition-colors">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" /><polyline points="16 17 21 12 16 7" /><line x1="21" y1="12" x2="9" y2="12" /></svg>
                Sign out
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function AlertsIndicator({ count }: { count: number }) {
  return (
    <button
      className="relative inline-flex items-center gap-2 rounded-lg px-3 py-2 text-sm text-muted-foreground transition-colors hover:text-foreground hover:bg-muted"
      aria-label={`${count} open alerts`}
    >
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4">
        <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
        <path d="M12 9v4" />
        <path d="M12 17h.01" />
      </svg>
      {count > 0 && (
        <span className="absolute -right-1 -top-1 flex h-4 w-4 items-center justify-center rounded-full bg-danger text-[10px] font-semibold text-white">
          {count > 99 ? '99+' : count}
        </span>
      )}
    </button>
  );
}

export default function TopHeader({ sidebarWidth }: { sidebarWidth: string }) {
  const [searchValue, setSearchValue] = useState('');
  const { alerts } = useDashboardData();
  const openAlerts = alerts.filter(a => a.status === 'open').length;

  return (
    <header
      className="fixed top-0 z-30 flex items-center gap-3 border-b bg-background px-4 sm:px-6 lg:px-8"
      style={{ left: sidebarWidth, width: `calc(100% - ${sidebarWidth})` }}
    >
      <div className="relative flex flex-1 max-w-md">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground">
          <circle cx="11" cy="11" r="8" /><path d="m21 21-4.35-4.35" />
        </svg>
        <input
          type="search"
          placeholder="Search services, ports, secrets, logs…"
          value={searchValue}
          onChange={e => setSearchValue(e.target.value)}
          className="w-full rounded-lg border bg-background pl-10 pr-4 py-2 text-sm placeholder:text-muted-foreground focus:border-primary focus:outline-none"
          aria-label="Global search"
        />
        <kbd className="absolute right-3 top-1/2 -translate-y-1/2 hidden sm:inline-flex h-5 items-center gap-1 rounded border bg-muted px-1.5 text-[10px] text-muted-foreground font-mono">
          <span className="text-xs">⌘</span>K
        </kbd>
      </div>

      <div className="flex items-center gap-2">
        <div className="hidden lg:flex rounded-lg border bg-muted p-1" role="group" aria-label="Environment selector">
          {environments.map(env => (
            <button
              key={env}
              className={cn('rounded-md px-3 py-1.5 text-xs font-medium transition-colors', env === 'prod' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground')}
              aria-pressed={env === 'prod'}
            >
              {env === 'dev' ? 'Dev' : env === 'test' ? 'Test' : env === 'stage' ? 'Stage' : 'Prod'}
            </button>
          ))}
        </div>

        <div className="h-6 w-px bg-border" />

        <AlertsIndicator count={openAlerts} />

        <button className="relative inline-flex items-center gap-2 rounded-lg px-3 py-2 text-sm text-muted-foreground transition-colors hover:text-foreground hover:bg-muted" aria-label="Notifications">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4">
            <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" /><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
          </svg>
          <span className="absolute -right-0.5 -top-0.5 flex h-2 w-2 items-center justify-center rounded-full bg-warning" />
        </button>

        <div className="h-6 w-px bg-border" />

        <ThemeToggle />
        <ProfileMenu />
      </div>
    </header>
  );
}
