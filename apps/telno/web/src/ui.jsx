import { createContext, useCallback, useContext, useEffect, useId, useMemo, useRef, useState } from 'react';

/* ---------------------------------------------------------------- icons --
   One stroke set, 20×20, 1.7 stroke. No icon package: the whole set is
   smaller than a single dependency and keeps the shell free of extra weight. */

const PATHS = {
  dashboard: 'M3 3h7v7H3zM14 3h7v4h-7zM14 11h7v10h-7zM3 14h7v7H3z',
  phone: 'M5 3h3l2 5-2.5 1.5a12 12 0 0 0 6 6L15 13l5 2v3a2 2 0 0 1-2.2 2A17.8 17.8 0 0 1 3 5.2 2 2 0 0 1 5 3z',
  calls: 'M5 3h3l2 5-2.5 1.5a12 12 0 0 0 6 6L15 13l5 2v3a2 2 0 0 1-2.2 2A17.8 17.8 0 0 1 3 5.2 2 2 0 0 1 5 3zM17 3v6M14 6h6',
  numbers: 'M4 9h16M4 15h16M10 3 8 21M16 3l-2 18',
  book: 'M4 4.5A2.5 2.5 0 0 1 6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5zM4 17h16',
  inbox: 'M3 12h5l2 3h4l2-3h5M3 12l3-8h12l3 8v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z',
  users: 'M16 20v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 10a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM22 20v-2a4 4 0 0 0-3-3.87M16 2.13A4 4 0 0 1 16 9.87',
  server: 'M3 4h18v6H3zM3 14h18v6H3zM6 7h.01M6 17h.01',
  branch: 'M6 3v12M6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM18 9a9 9 0 0 1-9 9',
  settings: 'M4 6h16M4 12h16M4 18h16M9 3v6M15 9v6M7 15v6',
  search: 'M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM21 21l-4.3-4.3',
  plus: 'M12 5v14M5 12h14',
  check: 'M20 6 9 17l-5-5',
  x: 'M18 6 6 18M6 6l12 12',
  chevron: 'M9 18l6-6-6-6',
  chevronDown: 'M6 9l6 6 6-6',
  copy: 'M9 9h10v12H9zM5 15H3V3h12v2',
  refresh: 'M3 12a9 9 0 0 1 15-6.7L21 8M21 3v5h-5M21 12a9 9 0 0 1-15 6.7L3 16M3 21v-5h5',
  external: 'M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6M15 3h6v6M10 14 21 3',
  shield: 'M12 2 4 6v6c0 5 3.4 9.4 8 10 4.6-.6 8-5 8-10V6z',
  key: 'M14 7a4 4 0 1 1-4 4c0-.7.2-1.4.5-2L3 16.5V21h4.5L15 13.5c.6.3 1.3.5 2 .5',
  globe: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM3 12h18M12 3a15 15 0 0 1 0 18 15 15 0 0 1 0-18z',
  clock: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7v5l3 2',
  arrowUp: 'M7 17 17 7M9 7h8v8',
  arrowDown: 'M17 7 7 17M15 17H7V9',
  alert: 'M12 9v4M12 17h.01M10.3 3.9 2.4 17.4A2 2 0 0 0 4.1 20.4h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z',
  logout: 'M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9',
  trash: 'M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 11v5M14 11v5',
  play: 'M6 4l14 8-14 8z',
  edit: 'M4 20h4L20 8l-4-4L4 16zM14 6l4 4',
  download: 'M12 3v12M7 11l5 5 5-5M4 21h16',
  paperclip: 'M20 11.5 12 19.5a5 5 0 0 1-7-7l8.5-8.5a3.5 3.5 0 0 1 5 5L10 18a2 2 0 0 1-3-3l7.5-7.5',
  menu: 'M4 7h16M4 12h16M4 17h16',
  mail: 'M3 6h18v12H3zM3 7l9 6 9-6',
  message: 'M21 12a8 8 0 0 1-11.6 7.1L4 21l1.9-5.4A8 8 0 1 1 21 12z',
  voicemail: 'M6 10a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM18 10a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM6 16h12',
  printer: 'M6 9V3h12v6M6 18H4v-6h16v6h-2M6 14h12v7H6z',
  wave: 'M2 12h3l2-6 3 12 3-9 2 6h5',
  flow: 'M5 4h5v5H5zM14 15h5v5h-5zM7.5 9v4a2 2 0 0 0 2 2H14',
  card: 'M3 6h18v12H3zM3 10h18M7 15h4',
  building: 'M4 21V5a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v16M14 9h4a2 2 0 0 1 2 2v10M2 21h20M8 7h2M8 11h2M8 15h2M17 13h1M17 17h1',
  pulse: 'M3 12h4l2-6 4 12 2-6h6',
  mic: 'M12 3a3 3 0 0 0-3 3v5a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3zM5 11a7 7 0 0 0 14 0M12 18v3',
  micOff: 'M3 3l18 18M9 6a3 3 0 0 1 6 0v2M15 14a3 3 0 0 1-6 0V9M5 11a7 7 0 0 0 10.5 6M19 11a7 7 0 0 1-.3 2M12 18v3',
  video: 'M3 7h11v10H3zM14 11l7-4v10l-7-4',
  videoOff: 'M3 3l18 18M3 7h8M14 11l7-4v10l-4-2.3M3 7v10h8',
  screen: 'M3 5h18v11H3zM8 21h8M12 16v5',
  terminal: 'M4 17l6-5-6-5M12 19h8',
};

export function Icon({ name, size = 16, className = '', ...rest }) {
  const path = PATHS[name] || PATHS.dashboard;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      {path.split('M').filter(Boolean).map((segment, index) => (
        <path key={index} d={`M${segment}`} />
      ))}
    </svg>
  );
}

/* --------------------------------------------------------------- toasts -- */

const ToastContext = createContext(null);

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);
  const counter = useRef(0);

  const remove = useCallback((id) => setToasts((list) => list.filter((t) => t.id !== id)), []);

  const push = useCallback(
    (tone, title, body) => {
      const id = ++counter.current;
      setToasts((list) => [...list.slice(-3), { id, tone, title, body }]);
      setTimeout(() => remove(id), tone === 'error' ? 7000 : 4200);
    },
    [remove]
  );

  const value = useMemo(
    () => ({
      success: (title, body) => push('success', title, body),
      error: (title, body) => push('error', title, body),
      info: (title, body) => push('info', title, body),
    }),
    [push]
  );

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="toasts" role="region" aria-live="polite" aria-label="Notifications">
        {toasts.map((toast) => (
          <div key={toast.id} className={`toast ${toast.tone}`}>
            <span className={`dot ${toast.tone === 'success' ? 'live' : toast.tone === 'error' ? 'down' : ''}`} />
            <div style={{ minWidth: 0 }}>
              <strong>{toast.title}</strong>
              {toast.body ? <p>{toast.body}</p> : null}
            </div>
            <button className="btn ghost icon sm" onClick={() => remove(toast.id)} aria-label="Dismiss">
              <Icon name="x" size={13} />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export const useToast = () => {
  const context = useContext(ToastContext);
  if (!context) throw new Error('useToast must be used inside ToastProvider');
  return context;
};

/* ------------------------------------------------------------ components -- */

export function Button({ children, variant = '', size = '', icon, loading, ...rest }) {
  return (
    <button className={['btn', variant, size].filter(Boolean).join(' ')} disabled={rest.disabled || loading} {...rest}>
      {loading ? <span className="spinner" /> : icon ? <Icon name={icon} size={14} /> : null}
      {children}
    </button>
  );
}

export const Badge = ({ tone = 'neutral', children, dot }) => (
  <span className={`badge ${tone}`}>
    {dot ? <span className={`dot ${dot}`} style={{ width: 6, height: 6 }} /> : null}
    {children}
  </span>
);

export function Card({ title, subtitle, actions, children, bodyClass = '', ...rest }) {
  return (
    <section className="card" {...rest}>
      {title || actions ? (
        <header className="card-head">
          <div style={{ minWidth: 0 }}>
            <h2 style={{ fontSize: '0.9375rem' }}>{title}</h2>
            {subtitle ? <p className="tiny dim" style={{ marginTop: 2 }}>{subtitle}</p> : null}
          </div>
          {actions ? <div className="row" style={{ marginLeft: 'auto' }}>{actions}</div> : null}
        </header>
      ) : null}
      <div className={`card-body ${bodyClass}`}>{children}</div>
    </section>
  );
}

export function Field({ label, hint, error, htmlFor, children, className = '' }) {
  return (
    <div className={`field ${className}`}>
      {label ? <label htmlFor={htmlFor}>{label}</label> : null}
      {children}
      {error ? <span className="error" role="alert">{error}</span> : hint ? <span className="hint">{hint}</span> : null}
    </div>
  );
}

export function Input({ label, hint, error, id, className = '', ...rest }) {
  const generated = useId();
  const inputId = id || generated;
  return (
    <Field label={label} hint={hint} error={error} htmlFor={inputId}>
      <input id={inputId} className={`input ${className}`} aria-invalid={error ? 'true' : undefined} {...rest} />
    </Field>
  );
}

export function Textarea({ label, hint, error, id, ...rest }) {
  const generated = useId();
  const inputId = id || generated;
  return (
    <Field label={label} hint={hint} error={error} htmlFor={inputId}>
      <textarea id={inputId} className="textarea" aria-invalid={error ? 'true' : undefined} {...rest} />
    </Field>
  );
}

export function Select({ label, hint, error, id, children, ...rest }) {
  const generated = useId();
  const inputId = id || generated;
  return (
    <Field label={label} hint={hint} error={error} htmlFor={inputId}>
      <select id={inputId} className="select" aria-invalid={error ? 'true' : undefined} {...rest}>
        {children}
      </select>
    </Field>
  );
}

export function Switch({ checked, onChange, label, ...rest }) {
  return (
    <label className="switch">
      <input type="checkbox" checked={!!checked} onChange={(e) => onChange?.(e.target.checked)} {...rest} />
      <span className="track" aria-hidden="true" />
      <span>{label}</span>
    </label>
  );
}

export const Empty = ({ icon = 'inbox', title, children, action }) => (
  <div className="empty">
    <Icon name={icon} size={24} />
    <strong>{title}</strong>
    {children ? <span>{children}</span> : null}
    {action}
  </div>
);

export const Spinner = () => <span className="spinner" role="status" aria-label="Loading" />;

export function Loading({ rows = 3 }) {
  return (
    <div className="stack" aria-busy="true" aria-live="polite">
      {Array.from({ length: rows }).map((_, index) => (
        <div key={index} className="skeleton" style={{ width: `${100 - index * 12}%` }} />
      ))}
    </div>
  );
}

export function Tabs({ tabs, value, onChange }) {
  return (
    <div className="tabs" role="tablist">
      {tabs.map((tab) => (
        <button
          key={tab.value}
          role="tab"
          type="button"
          aria-selected={value === tab.value}
          onClick={() => onChange(tab.value)}
        >
          {tab.label}
          {tab.count !== undefined ? <span className="count">{tab.count}</span> : null}
        </button>
      ))}
    </div>
  );
}

export function Modal({ title, subtitle, children, footer, onClose, wide }) {
  const ref = useRef(null);
  const titleId = useId();

  useEffect(() => {
    const previous = document.activeElement;
    const node = ref.current;
    // Prefer the first real field over the close button.
    const field = node?.querySelector('input:not([type="hidden"]), select, textarea');
    (field || node?.querySelector('.dialog-foot button, .dialog-body button'))?.focus();

    const onKey = (event) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose?.();
      }
      if (event.key === 'Tab' && node) {
        const items = [...node.querySelectorAll('a[href], button:not([disabled]), input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])')];
        if (!items.length) return;
        const first = items[0];
        const last = items[items.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      previous?.focus?.();
    };
  }, [onClose]);

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose?.()}>
      <div className={`dialog ${wide ? 'wide' : ''}`} role="dialog" aria-modal="true" aria-labelledby={titleId} ref={ref}>
        <header className="dialog-head">
          <div style={{ minWidth: 0 }}>
            <h2 id={titleId} style={{ fontSize: '1rem' }}>{title}</h2>
            {subtitle ? <p className="tiny dim">{subtitle}</p> : null}
          </div>
          <Button variant="ghost" size="icon" onClick={onClose} aria-label="Close dialog" style={{ marginLeft: 'auto' }}>
            <Icon name="x" />
          </Button>
        </header>
        <div className="dialog-body">{children}</div>
        {footer ? <div className="dialog-foot">{footer}</div> : null}
      </div>
    </div>
  );
}

export function Stat({ label, value, foot, tone }) {
  return (
    <div className="stat">
      <span className="stat-label">{label}</span>
      <span className="stat-value" style={tone ? { color: tone } : undefined}>{value}</span>
      {foot ? <span className="stat-foot">{foot}</span> : null}
    </div>
  );
}

export function PageHeader({ title, subtitle, actions }) {
  return (
    <div className="row" style={{ alignItems: 'flex-start', gap: 14, flexWrap: 'wrap' }}>
      <div style={{ minWidth: 0 }}>
        <h1 style={{ fontSize: '1.375rem' }}>{title}</h1>
        {subtitle ? <p className="muted tiny" style={{ marginTop: 2 }}>{subtitle}</p> : null}
      </div>
      {actions ? <div className="row wrap" style={{ marginLeft: 'auto' }}>{actions}</div> : null}
    </div>
  );
}

export const initials = (name) =>
  String(name || '?')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0])
    .join('')
    .toUpperCase();

export const statusTone = (status) =>
  ({
    answered: 'success',
    active: 'success',
    approved: 'success',
    verified: 'info',
    registered: 'info',
    pending: 'warning',
    awaiting_verification: 'warning',
    'no-answer': 'warning',
    busy: 'warning',
    voicemail: 'info',
    duplicate: 'neutral',
    rejected: 'danger',
    failed: 'danger',
    congestion: 'danger',
    retired: 'neutral',
    reserved: 'neutral',
    expired: 'neutral',
  })[status] || 'neutral';
