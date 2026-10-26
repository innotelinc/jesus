import { useEffect, useState } from 'react';
import { api } from './api.js';
import { Icon, Badge, Button, useToast } from './ui.jsx';
import { Link } from './router.jsx';
import { useAuth } from './auth.jsx';
import { openSoftphoneWindow } from './softphoneWindow.js';

const GROUPS = [
  {
    label: 'Telephony',
    items: [
      { path: '/', label: 'Dashboard', icon: 'dashboard' },
      { path: '/softphone', label: 'Softphone', icon: 'phone' },
      { path: '/calls', label: 'Call history', icon: 'calls' },
      { path: '/extensions', label: 'Extensions', icon: 'users' },
      { path: '/trunks', label: 'Trunks', icon: 'server' },
      { path: '/ivr', label: 'Call routing', icon: 'branch' },
      { path: '/voicemail', label: 'Voicemail', icon: 'voicemail' },
      { path: '/fax', label: 'Fax', icon: 'printer' },
      { path: '/messages', label: 'Messages', icon: 'message' },
    ],
  },
  {
    label: 'Voice & automation',
    items: [
      { path: '/voice', label: 'Voice agents', icon: 'wave' },
      { path: '/workflows', label: 'Workflows', icon: 'flow' },
    ],
  },
  {
    label: 'Registry',
    items: [
      { path: '/numbers', label: 'Numbers', icon: 'numbers' },
      { path: '/directory', label: 'Moderation', icon: 'inbox', badge: 'pending' },
    ],
  },
  {
    label: 'Business',
    items: [
      { path: '/billing', label: 'Billing', icon: 'card' },
      { path: '/estate', label: 'Estate', icon: 'building' },
    ],
  },
  {
    label: 'Operations',
    items: [
      { path: '/health', label: 'Health', icon: 'pulse' },
      { path: '/operations', label: 'Operations', icon: 'terminal' },
      { path: '/systems', label: 'Connected systems', icon: 'globe' },
      { path: '/settings', label: 'Settings', icon: 'settings' },
    ],
  },
];

const MOBILE = [
  { path: '/', label: 'Home', icon: 'dashboard' },
  { path: '/softphone', label: 'Dial', icon: 'phone' },
  { path: '/calls', label: 'Calls', icon: 'calls' },
  { path: '/voicemail', label: 'Inbox', icon: 'voicemail' },
  { path: '/numbers', label: 'Numbers', icon: 'numbers' },
  { path: '/operations', label: 'Ops', icon: 'terminal' },
];

export default function Shell({ path, title, subtitle, children }) {
  const { user, logout } = useAuth();
  const toast = useToast();
  const [health, setHealth] = useState(null);
  const [pending, setPending] = useState(0);

  useEffect(() => {
    let canceled = false;
    const load = async () => {
      try {
        const data = await api.get('/system/status');
        if (!canceled) {
          setHealth(data);
          setPending(data.counts?.pending || 0);
        }
      } catch {
        if (!canceled) setHealth(null);
      }
    };
    load();
    const timer = setInterval(load, 30000);
    return () => {
      canceled = true;
      clearInterval(timer);
    };
  }, [path]);

  const telephony = health?.telephony;
  const connected = telephony?.connected && !telephony?.simulated;
  const statusLabel = connected ? 'Switch connected' : telephony?.simulated ? 'Simulated switch' : 'Switch offline';
  const statusTone = connected ? 'live' : telephony?.simulated ? 'warn' : 'down';

  return (
    <div className="shell">
      <a className="skip-link" href="#main">
        Skip to content
      </a>

      <div className="brand">
        <span className="brand-mark" aria-hidden="true">
          <Icon name="phone" size={15} />
        </span>
        <span className="brand-name">
          tel<span>no</span>
        </span>
        <span className="brand-sub">v1.0</span>
      </div>

      <header className="topbar">
        <div className="topbar-title">
          <span className="truncate">{title}</span>
          <small className="dim">{subtitle}</small>
        </div>

        <span
          className="badge neutral"
          title={telephony?.error ? `AMI: ${telephony.error}` : statusLabel}
          style={{ marginRight: 2 }}
        >
          <span className={`dot ${statusTone}`} />
          <span className="nowrap" style={{ display: 'none' }}>
            {statusLabel}
          </span>
          <span className="nowrap">{telephony?.simulated ? 'Simulated' : connected ? 'Live' : 'Offline'}</span>
        </span>

        <div className="row" style={{ gap: 8 }}>
          <Button
            variant="ghost"
            size="icon"
            aria-label="Open the softphone in its own window"
            title="Open the softphone in its own window — it stays registered while you work"
            onClick={async () => {
              const result = await openSoftphoneWindow();
              if (result.blocked) toast.error('The window was blocked', 'Allow popups for this site, then try again');
              else if (result.focused) toast.success('Softphone window is already open');
              else toast.success('Softphone opened in its own window', 'It stays registered while you browse');
            }}
          >
            <Icon name="phone" />
          </Button>
          <span className="tiny dim nowrap" style={{ maxWidth: 130, overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {user?.email}
          </span>
          <Button variant="ghost" size="icon" onClick={logout} aria-label="Sign out" title="Sign out">
            <Icon name="logout" />
          </Button>
        </div>
      </header>

      <nav className="sidebar" aria-label="Sections">
        {GROUPS.map((group) => (
          <div className="nav-group" key={group.label}>
            <span className="nav-label">{group.label}</span>
            {group.items.map((item) => (
              <Link
                key={item.path}
                to={item.path}
                className="nav-item"
                aria-current={path === item.path ? 'page' : undefined}
              >
                <Icon name={item.icon} size={15} />
                <span>{item.label}</span>
                {item.badge === 'pending' && pending > 0 ? <span className="nav-badge">{pending}</span> : null}
              </Link>
            ))}
          </div>
        ))}

        <div className="sidebar-footer">
          <a
            className="nav-item"
            href={`/d/${health?.catalog?.canonical || 'telno.directory'}`}
            target="_blank"
            rel="noreferrer"
          >
            <Icon name="globe" size={15} />
            <span>Public directory</span>
            <Icon name="external" size={12} className="right dim" />
          </a>
          <div className="status-line">
            <span className={`dot ${statusTone}`} />
            <span>{statusLabel}</span>
          </div>
        </div>
      </nav>

      <main className="main" id="main" tabIndex={-1}>
        <div className="container">{children}</div>
      </main>

      <nav className="bottom-nav" aria-label="Primary">
        {MOBILE.map((item) => (
          <Link key={item.path} to={item.path} aria-current={path === item.path ? 'page' : undefined}>
            <Icon name={item.icon} size={19} />
            <span>{item.label}</span>
          </Link>
        ))}
      </nav>
    </div>
  );
}
