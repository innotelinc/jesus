import type { ReactNode } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { cn } from '../lib/utils';

interface SidebarProps {
  className?: string;
  width?: string;
}

type NavItem = { label: string; path: string; icon: ReactNode };

const icon = (path: string) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-[18px] w-[18px]">{path}</svg>
);

const groups: { label: string; items: NavItem[] }[] = [
  {
    label: 'Overview',
    items: [
      { label: 'Dashboard', path: '/', icon: icon('<rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" />') },
      { label: 'Monitoring', path: '/monitoring', icon: icon('<path d="M3 3v18h18" /><path d="m19 9-5 5-4-4-3 3" />') },
      { label: 'Health & Status', path: '/health', icon: icon('<path d="M22 12h-4l-3 9L9 3l-3 9H2" />') },
    ],
  },
  {
    label: 'Manage',
    items: [
      { label: 'Services', path: '/services', icon: icon('<rect x="2" y="3" width="20" height="14" rx="2" /><path d="M8 21h8" /><path d="M12 17v4" />') },
      { label: 'Network Ports', path: '/ports', icon: icon('<circle cx="12" cy="12" r="3" /><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42" />') },
      { label: 'Secrets Vault', path: '/secrets', icon: icon('<rect x="3" y="11" width="18" height="11" rx="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" />') },
      { label: 'Alerts', path: '/alerts', icon: icon('<path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" /><path d="M12 9v4" /><path d="M12 17h.01" />') },
      { label: 'Configuration', path: '/config', icon: icon('<circle cx="12" cy="12" r="3" /><path d="M12 1v4M12 19v4M4.22 4.22l2.36 2.36M17.42 17.42l2.36 2.36M1 12h4M19 12h4M4.22 19.78l2.36-2.36M17.42 6.58l2.36-2.36" />') },
      { label: 'Users & Access', path: '/users', icon: icon('<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M23 21v-2a4 4 0 0 0-3-3.87" /><path d="M16 3.13a4 4 0 0 1 0 7.75" />') },
    ],
  },
  {
    label: 'Tools',
    items: [
      { label: 'Softphone', path: '/softphone', icon: icon('<path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z" />') },
      { label: 'Password Generator', path: '/password', icon: icon('<path d="M12 2a6 6 0 0 0 9 9 6 6 0 0 0-9 9" /><path d="M12 14a2 2 0 1 0 0-4 2 2 0 0 0 0 4z" /><path d="M2 12h2" /><path d="M20 12h2" /><path d="M12 20v2" /><path d="M12 4v2" />') },
      { label: 'Links & Resources', path: '/links', icon: icon('<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" /><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />') },
      { label: 'Logs', path: '/logs', icon: icon('<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path d="m9 13 2 2 4-4" />') },
      { label: 'Settings', path: '/settings', icon: icon('<path d="M12.22 12.85 10 12.25a1.5 1.5 0 0 0-2.55.55l-1.47 1.8a1.5 1.5 0 0 1-1.1.45h-.89a1.5 1.5 0 0 0-1.1-.45l-1.47-1.8a1.5 1.5 0 0 0-2.55-.55l-2.22 1A1.5 1.5 0 0 0 .78 12.85l-2.22-1A1.5 1.5 0 0 1 3.53 7.25h.89a1.5 1.5 0 0 0 1.1.45l1.47-1.8a1.5 1.5 0 0 1 2.55-.55l2.22 1A1.5 1.5 0 0 0 20.47 12h.22a1.5 1.5 0 0 0 1.1-.45l1.47-1.8a1.5 1.5 0 0 1 2.55.55l2.22 1A1.5 1.5 0 0 1 19.47 16.15l2.22-1A1.5 1.5 0 0 0 20.22 12.85l.22-.85z" />') },
    ],
  },
];

export default function Sidebar({ className, width = '240px' }: SidebarProps) {
  const location = useLocation();

  return (
    <nav className={cn('flex h-full flex-col border-r bg-sidebar px-3 py-4', className)} style={{ width }}>
      <div className="flex items-center gap-3 px-2 pb-5">
        <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-primary to-info text-primary-foreground shadow-lg shadow-primary/20">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-5 w-5">
            <path d="M3 3h18v18H3z" /><path d="M9 9h6v6H9z" /><path d="m9 15 3-3 3 3" />
          </svg>
        </div>
        <div className="flex min-w-0 flex-col leading-tight">
          <span className="truncate text-[15px] font-bold tracking-tight">Capstone</span>
          <span className="text-xs text-muted-foreground">Control Center</span>
        </div>
      </div>

      <div className="flex-1 space-y-5 overflow-y-auto scrollbar-thin">
        {groups.map(group => (
          <div key={group.label}>
            <div className="px-2 pb-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/70">
              {group.label}
            </div>
            <div className="flex flex-col gap-0.5">
              {group.items.map(item => {
                const isActive = item.path === '/' ? location.pathname === '/' : location.pathname.startsWith(item.path);
                return (
                  <NavLink
                    key={item.path}
                    to={item.path}
                    end={item.path === '/'}
                    className={cn(
                      'flex items-center gap-3 rounded-lg px-2.5 py-2 text-[13px] font-medium transition-colors',
                      isActive
                        ? 'bg-primary/10 text-primary'
                        : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                    )}
                  >
                    <span className={cn('shrink-0 transition-colors', isActive ? 'text-primary' : 'text-muted-foreground/80')}>
                      {item.icon}
                    </span>
                    <span className="truncate">{item.label}</span>
                  </NavLink>
                );
              })}
            </div>
          </div>
        ))}
      </div>

      <div className="mt-4 flex items-center justify-between rounded-lg border border-border/60 bg-muted/30 px-3 py-2.5">
        <div className="flex items-center gap-2">
          <span className="h-2 w-2 rounded-full bg-success animate-pulse-slow" />
          <span className="text-xs font-medium">Operational</span>
        </div>
        <span className="text-[11px] text-muted-foreground">v0.1.0</span>
      </div>
    </nav>
  );
}