import { useMemo, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useResolvedTheme } from './providers';
import { useDashboardData } from '../context/DashboardDataContext';

// Section label shown for the current route (falls back to the raw path).
const SECTION_LABELS: [string, string][] = [
  ['/', 'Dashboard'],
  ['/services', 'Services'],
  ['/ports', 'Network Ports'],
  ['/health', 'Health & Status'],
  ['/monitoring', 'Monitoring'],
  ['/secrets', 'Secrets Vault'],
  ['/password', 'Password Generator'],
  ['/softphone', 'Softphone'],
  ['/links', 'Links & Resources'],
  ['/alerts', 'Alerts'],
  ['/config', 'Configuration'],
  ['/users', 'Users & Access'],
  ['/logs', 'Logs'],
  ['/settings', 'Settings'],
];

function ThemeToggle() {
  const { theme, setTheme } = useResolvedTheme();
  return (
    <button
      className="inline-flex h-9 w-9 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
      onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
      aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}
    >
      {theme === 'dark' ? (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-[18px] w-[18px]">
          <circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
        </svg>
      ) : (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-[18px] w-[18px]">
          <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
        </svg>
      )}
    </button>
  );
}

function ProfileMenu() {
  const [open, setOpen] = useState(false);
  const { users } = useDashboardData();
  const admin = users.find(u => u.role === 'admin');
  const displayName = admin?.name ?? 'Admin';
  const email = admin?.email ?? 'admin@capstone.internal';
  const initials =
    displayName
      .split(/[\s._-]+/)
      .filter(Boolean)
      .slice(0, 2)
      .map(p => p[0]?.toUpperCase() ?? '')
      .join('') || 'A';

  return (
    <div className="relative">
      <button
        className="flex items-center gap-2 rounded-lg px-1.5 py-1 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label="User profile menu"
      >
        <div className="flex h-8 w-8 items-center justify-center rounded-full bg-gradient-to-br from-primary to-info text-xs font-semibold uppercase text-primary-foreground">
          {initials}
        </div>
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div
            className="absolute right-0 z-20 mt-2 w-56 rounded-xl border bg-popover p-2 shadow-xl animate-in"
            role="menu"
            aria-label="User profile"
          >
            <div className="flex items-center gap-3 rounded-lg px-3 py-2 text-sm">
              <div className="flex h-9 w-9 items-center justify-center rounded-full bg-gradient-to-br from-primary to-info text-xs font-semibold uppercase text-primary-foreground">
                {initials}
              </div>
              <div className="min-w-0">
                <div className="truncate font-medium">{displayName}</div>
                <div className="truncate text-xs text-muted-foreground">{email}</div>
              </div>
            </div>
            <div className="mt-2 border-t border-border pt-2" />
            <div className="flex flex-col gap-0.5 text-sm">
              <button className="flex items-center gap-2 rounded-lg px-3 py-2 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4"><circle cx="12" cy="8" r="4" /><path d="M20 21a8 8 0 1 0-16 0" /></svg>
                Profile
              </button>
              <button className="flex items-center gap-2 rounded-lg px-3 py-2 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" /><circle cx="12" cy="7" r="4" /></svg>
                Account settings
              </button>
              <button className="flex items-center gap-2 rounded-lg px-3 py-2 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground">
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

export default function TopHeader({ sidebarWidth }: { sidebarWidth: string }) {
  const { alerts } = useDashboardData();
  const location = useLocation();
  const navigate = useNavigate();
  const openAlerts = alerts.filter(a => a.status === 'open').length;

  const section = useMemo(() => {
    const match = SECTION_LABELS.find(([path]) => path !== '/' && location.pathname.startsWith(path));
    if (location.pathname === '/') return 'Dashboard';
    return match ? match[1] : location.pathname.replace(/^\//, '') || 'Dashboard';
  }, [location.pathname]);

  return (
    <header
      className="fixed top-0 z-30 flex h-14 items-center justify-between border-b bg-background/80 px-4 backdrop-blur sm:px-6 lg:px-8"
      style={{ left: sidebarWidth, width: `calc(100% - ${sidebarWidth})` }}
    >
      <div className="flex min-w-0 items-center gap-2 text-sm">
        <span className="hidden text-muted-foreground sm:inline">Control Center</span>
        <span className="hidden text-muted-foreground/50 sm:inline">/</span>
        <span className="truncate font-semibold tracking-tight">{section}</span>
      </div>

      <div className="flex items-center gap-1.5">
        <button
          onClick={() => navigate('/alerts')}
          className="relative inline-flex h-9 w-9 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          aria-label={`${openAlerts} open alerts`}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-[18px] w-[18px]">
            <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" /><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
          </svg>
          {openAlerts > 0 && (
            <span className="absolute right-1 top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-danger px-1 text-[10px] font-semibold text-white">
              {openAlerts > 99 ? '99+' : openAlerts}
            </span>
          )}
        </button>
        <ThemeToggle />
        <div className="mx-1 h-6 w-px bg-border" />
        <ProfileMenu />
      </div>
    </header>
  );
}