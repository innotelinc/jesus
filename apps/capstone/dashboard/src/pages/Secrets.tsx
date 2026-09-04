import { useState, useMemo } from 'react';
import type { Secret } from '../types';
import { useDashboardData } from '../context/DashboardDataContext';
import StatusBadge from '../components/StatusBadge';
import Button from '../components/Button';
import Drawer from '../components/Drawer';
import { cn, formatRelativeTime } from '../lib/utils';
import Modal from '../components/Modal';
import Input from '../components/Input';
import Select from '../components/Select';

function secretTypeBadge(type: string) {
  switch (type) {
    case 'api-key':
      return <span className="inline-flex items-center gap-1 rounded-full bg-info/20 px-2 py-0.5 text-xs font-medium text-info"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-3 w-3"><rect x="3" y="11" width="18" height="11" rx="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" /></svg>API key</span>;
    case 'password':
      return <span className="inline-flex items-center gap-1 rounded-full bg-warning/20 px-2 py-0.5 text-xs font-medium text-warning"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-3 w-3"><rect x="3" y="11" width="18" height="11" rx="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" /></svg>Password</span>;
    case 'certificate':
      return <span className="inline-flex items-center gap-1 rounded-full bg-success/20 px-2 py-0.5 text-xs font-medium text-success"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-3 w-3"><circle cx="12" cy="12" r="10" /><path d="M12 8v4" /><path d="M12 16h.01" /></svg>Certificate</span>;
    case 'token':
      return <span className="inline-flex items-center gap-1 rounded-full bg-accent/20 px-2 py-0.5 text-xs font-medium text-accent-foreground"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-3 w-3"><path d="M12 2a6 6 0 0 0 9 9 6 6 0 0 0-9 9" /><path d="M12 14a2 2 0 1 0 0-4 2 2 0 0 0 0 4z" /></svg>Token</span>;
    case 'credential':
      return <span className="inline-flex items-center gap-1 rounded-full bg-muted text-muted-foreground px-2 py-0.5 text-xs font-medium"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-3 w-3"><rect x="3" y="11" width="18" height="11" rx="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" /></svg>Credential</span>;
    default:
      return <span className="text-xs text-muted-foreground">{type}</span>;
  }
}

function expiryClass(expiresAt: string) {
  const days = Math.ceil((new Date(expiresAt).getTime() - Date.now()) / 86400000);
  if (days <= 0) return 'text-danger';
  if (days <= 7) return 'text-warning';
  return 'text-muted-foreground';
}

export default function Secrets() {
  const { secrets, auditLog } = useDashboardData();
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [envFilter, setEnvFilter] = useState('all');
  const [selected, setSelected] = useState<Secret | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [copyFeedback, setCopyFeedback] = useState<string | null>(null);

  const filtered = useMemo(() => {
    return secrets.filter(s => {
      const matchesSearch = search === '' || s.name.toLowerCase().includes(search.toLowerCase());
      const matchesStatus = statusFilter === 'all' || s.status === statusFilter;
      const matchesEnv = envFilter === 'all' || s.environment === envFilter;
      return matchesSearch && matchesStatus && matchesEnv;
    });
  }, [search, statusFilter, envFilter]);

  const openDrawer = (secret: Secret) => {
    setSelected(secret);
    setDrawerOpen(true);
  };

  const copyValue = (id: string) => {
    setCopyFeedback(id);
    setTimeout(() => setCopyFeedback(null), 2000);
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Secrets Vault</h1>
          <p className="mt-1 text-sm text-muted-foreground">Manage API keys, passwords, certificates, and tokens with rotation tracking.</p>
        </div>
        <Button variant="default" size="sm" onClick={() => setCreateOpen(true)}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4"><path d="M12 5v14M5 12h14" /></svg>
          Create secret
        </Button>
      </div>

      <div className="flex flex-wrap gap-3">
        <div className="relative">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground"><circle cx="11" cy="11" r="8" /><path d="m21 21-4.35-4.35" /></svg>
          <input
            type="search"
            placeholder="Search secrets by name…"
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="h-9 w-full min-w-[220px] rounded-md border bg-background pl-9 pr-3 py-2 text-sm placeholder:text-muted-foreground focus:border-primary focus:outline-none"
            aria-label="Search secrets"
          />
        </div>
        <div className="flex rounded-md border bg-background p-1" role="group" aria-label="Status filter">
          {['all', 'active', 'rotated', 'expired', 'pending'].map(opt => (
            <button
              key={opt}
              onClick={() => setStatusFilter(opt)}
              className={cn('rounded-md px-3 py-1.5 text-xs font-medium transition-colors', statusFilter === opt ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground')}
            >
              {opt === 'all' ? 'All' : opt.charAt(0).toUpperCase() + opt.slice(1)}
            </button>
          ))}
        </div>
        <div className="flex rounded-md border bg-background p-1" role="group" aria-label="Environment filter">
          {['all', 'prod', 'stage', 'test', 'dev'].map(opt => (
            <button
              key={opt}
              onClick={() => setEnvFilter(opt)}
              className={cn('rounded-md px-3 py-1.5 text-xs font-medium transition-colors', envFilter === opt ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground')}
            >
              {opt === 'all' ? 'All envs' : opt === 'prod' ? 'Prod' : opt === 'stage' ? 'Stage' : opt === 'test' ? 'Test' : opt === 'dev' ? 'Dev' : opt}
            </button>
          ))}
        </div>
      </div>

      <div className="border rounded-2xl bg-card shadow-sm overflow-hidden">
        <table className="w-full border-collapse">
          <thead>
            <tr className="border-b bg-muted/30">
              <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-muted-foreground">Secret</th>
              <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-muted-foreground">Type</th>
              <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-muted-foreground">Environment</th>
              <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-muted-foreground">Owner</th>
              <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-muted-foreground">Rotated</th>
              <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-muted-foreground">Expires</th>
              <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-muted-foreground">Status</th>
              <th className="px-4 py-3 text-right text-xs font-semibold uppercase tracking-wider text-muted-foreground">Permissions</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {filtered.map(secret => (
              <tr key={secret.id} className="hover:bg-muted/40 transition-colors cursor-pointer" onClick={() => openDrawer(secret)}>
                <td className="px-4 py-3">
                  <div className="flex items-center gap-2">
                    <div className="flex h-7 w-7 items-center justify-center rounded bg-primary/10 text-primary text-xs font-semibold">
                      {secret.name.charAt(0)}
                    </div>
                    <span className="font-medium">{secret.name}</span>
                  </div>
                </td>
                <td className="px-4 py-3">{secretTypeBadge(secret.type)}</td>
                <td className="px-4 py-3">
                  <span className={cn('rounded-full px-2 py-0.5 text-xs font-medium', secret.environment === 'prod' ? 'bg-success/20 text-success' : secret.environment === 'stage' ? 'bg-info/20 text-info' : secret.environment === 'test' ? 'bg-warning/20 text-warning' : 'bg-muted-foreground/20 text-muted-foreground')}>
                    {secret.environment}
                  </span>
                </td>
                <td className="px-4 py-3 text-sm text-muted-foreground">{secret.owner}</td>
                <td className="px-4 py-3 text-sm text-muted-foreground">{formatRelativeTime(secret.rotatedAt)}</td>
                <td className="px-4 py-3 text-sm">
                  <span className={cn('font-medium', expiryClass(secret.expiresAt))}>
                    {formatRelativeTime(secret.expiresAt)}
                  </span>
                </td>
                <td className="px-4 py-3"><StatusBadge status={secret.status} size="sm" /></td>
                <td className="px-4 py-3 text-right">
                  <div className="flex flex-wrap gap-1 justify-end">
                    {secret.permissions.map(p => (
                      <span key={p.role} className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">{p.role}</span>
                    ))}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {filtered.length === 0 && (
          <div className="flex flex-col items-center justify-center py-12 border-t text-center">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="mx-auto h-8 w-8 text-muted-foreground"><rect x="3" y="11" width="18" height="11" rx="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" /></svg>
            <p className="mt-2 text-sm font-medium">No secrets match your filters.</p>
            <p className="text-xs text-muted-foreground">Try clearing the search or filters.</p>
          </div>
        )}
      </div>

      <Drawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        title={selected?.name ?? 'Secret'}
        size="md"
      >
        {selected && (
          <div className="space-y-5">
            <div className="grid gap-3 border rounded-2xl bg-card p-5 text-sm">
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Type</span>
                <div>{secretTypeBadge(selected.type)}</div>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Environment</span>
                <span className={cn('rounded-full px-2 py-0.5 text-xs font-medium', selected.environment === 'prod' ? 'bg-success/20 text-success' : selected.environment === 'stage' ? 'bg-info/20 text-info' : selected.environment === 'test' ? 'bg-warning/20 text-warning' : 'bg-muted-foreground/20 text-muted-foreground')}>
                  {selected.environment}
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Owner</span>
                <span className="font-medium">{selected.owner}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Rotated at</span>
                <span className="font-medium">{formatRelativeTime(selected.rotatedAt)}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Expires at</span>
                <span className={cn('font-medium', expiryClass(selected.expiresAt))}>{formatRelativeTime(selected.expiresAt)}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Status</span>
                <StatusBadge status={selected.status} size="md" />
              </div>
            </div>

            <div className="space-y-2">
              <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">Access Permissions</h3>
              <div className="divide-y">
                {selected.permissions.map((p, idx) => (
                  <div key={idx} className="flex items-center justify-between py-2">
                    <span className="text-sm">
                      <span className={cn('rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary', p.role)}>{p.role}</span>
                    </span>
                    <span className="text-xs text-muted-foreground">Granted {formatRelativeTime(p.grantedAt)}</span>
                  </div>
                ))}
              </div>
            </div>

            <div className="space-y-2 border-t pt-4">
              <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">Audit History</h3>
              <div className="divide-y">
                {auditLog.filter(a => a.resource.includes(selected.id || '')).length === 0 ? (
                  <div className="py-4 text-center text-sm text-muted-foreground">No audit entries for this secret.</div>
                ) : (
                  auditLog.slice(0, 3).map((a, i) => (
                    <div key={i} className="flex items-center justify-between py-2">
                      <div className="flex items-center gap-2">
                        <span className="text-xs text-muted-foreground">{formatRelativeTime(a.timestamp)}</span>
                        <span className="text-xs text-muted-foreground">{a.actor}</span>
                      </div>
                      <span className="text-xs text-muted-foreground">{a.action}</span>
                    </div>
                  ))
                )}
              </div>
            </div>

            <div className="flex flex-wrap gap-2 pt-2">
              <Button variant="secondary" size="sm" onClick={() => copyValue(selected.id)}>
                {copyFeedback === selected.id ? 'Copied!' : 'Copy value securely'}
              </Button>
              <Button variant="outline" size="sm">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4"><path d="M1 4v6h6" /><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" /></svg>
                Rotate
              </Button>
              <Button variant="outline" size="sm">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4"><path d="M3 3v18h18" /><path d="m19 9-5 5-4-4-3 3" /></svg>
                View metadata
              </Button>
            </div>
          </div>
        )}
      </Drawer>

      <Modal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        title="Create secret"
        size="md"
      >
        <div className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label className="text-sm font-medium">Name</label>
              <Input className="mt-1" placeholder="e.g. API_KEY_NAME" />
            </div>
            <div>
              <label className="text-sm font-medium">Type</label>
              <Select
                value=""
                options={[
                  { value: 'api-key', label: 'API key' },
                  { value: 'password', label: 'Password' },
                  { value: 'certificate', label: 'Certificate' },
                  { value: 'token', label: 'Token' },
                  { value: 'credential', label: 'Credential' },
                ]}
                onChange={() => {}}
                className="mt-1"
              />
            </div>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label className="text-sm font-medium">Environment</label>
              <Select
                value="prod"
                options={[
                  { value: 'prod', label: 'Production' },
                  { value: 'stage', label: 'Stage' },
                  { value: 'test', label: 'Test' },
                  { value: 'dev', label: 'Dev' },
                ]}
                onChange={() => {}}
                className="mt-1"
              />
            </div>
            <div>
              <label className="text-sm font-medium">Owner</label>
              <Input className="mt-1" placeholder="team@capstone.internal" />
            </div>
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" size="sm" onClick={() => setCreateOpen(false)}>Cancel</Button>
            <Button variant="default" size="sm">Create secret</Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
