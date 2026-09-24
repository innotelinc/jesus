import { useMemo, useState } from 'react';
import type { ConfigPolicy } from '../types';
import { useDashboardData } from '../context/DashboardDataContext';
import Button from '../components/Button';
import StatusBadge from '../components/StatusBadge';
import { cn, formatRelativeTime } from '../lib/utils';
import { exportJSON } from '../lib/export';

export default function Config() {
  const { policies } = useDashboardData();
  const [search, setSearch] = useState('');
  const [showDisabled, setShowDisabled] = useState(true);

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return policies.filter(policy => {
      const matchesSearch = !needle || policy.name.toLowerCase().includes(needle) || policy.description.toLowerCase().includes(needle) || policy.value.toLowerCase().includes(needle);
      return matchesSearch && (showDisabled || policy.enabled);
    });
  }, [policies, search, showDisabled]);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Configuration</h1>
          <p className="mt-1 text-sm text-muted-foreground">Review platform policy defaults and operational configuration values.</p>
        </div>
        <Button variant="outline" size="sm" onClick={() => exportJSON(policies, { filename: `capstone-configuration-${new Date().toISOString().slice(0, 10)}.json` })}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="7 10 12 15 17 10" /><path d="M12 15V3" /></svg>
          Export configuration
        </Button>
      </div>

      <div className="rounded-xl border border-warning/30 bg-warning/5 px-4 py-3 text-sm">
        <span className="font-medium">Read-only policy reference.</span>{' '}
        <span className="text-muted-foreground">Runtime policy changes belong in the deployment environment or owning service. The Control Center does not pretend to persist edits.</span>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <div className="rounded-2xl border bg-card p-4 shadow-sm"><div className="text-xs uppercase tracking-wide text-muted-foreground">Policies</div><div className="mt-1 text-2xl font-semibold">{policies.length}</div></div>
        <div className="rounded-2xl border bg-card p-4 shadow-sm"><div className="text-xs uppercase tracking-wide text-muted-foreground">Enabled</div><div className="mt-1 text-2xl font-semibold text-success">{policies.filter(policy => policy.enabled).length}</div></div>
        <div className="rounded-2xl border bg-card p-4 shadow-sm"><div className="text-xs uppercase tracking-wide text-muted-foreground">Disabled</div><div className="mt-1 text-2xl font-semibold text-warning">{policies.filter(policy => !policy.enabled).length}</div></div>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <input
          type="search"
          value={search}
          onChange={event => setSearch(event.target.value)}
          placeholder="Search policies and values…"
          aria-label="Search configuration policies"
          className="h-9 w-full min-w-[260px] rounded-md border bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus:border-primary focus:outline-none"
        />
        <label className="flex items-center gap-2 text-sm text-muted-foreground">
          <input type="checkbox" checked={showDisabled} onChange={event => setShowDisabled(event.target.checked)} className="h-4 w-4 accent-primary" />
          Show disabled policies
        </label>
      </div>

      <div className="overflow-x-auto rounded-2xl border bg-card shadow-sm">
        <table className="w-full min-w-[840px] border-collapse">
          <thead><tr className="border-b bg-muted/30">
            {['Policy', 'Description', 'Status', 'Value', 'Last updated'].map((heading, index) => <th key={heading} className={cn('px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-muted-foreground', index >= 2 && 'text-right')}>{heading}</th>)}
          </tr></thead>
          <tbody className="divide-y">
            {filtered.map((policy: ConfigPolicy) => (
              <tr key={policy.id} className="transition-colors hover:bg-muted/40">
                <td className="px-4 py-3"><div className="flex items-center gap-2"><div className="flex h-7 w-7 items-center justify-center rounded bg-primary/10 text-xs font-semibold text-primary">{policy.name.charAt(0)}</div><span className="font-medium">{policy.name}</span></div></td>
                <td className="max-w-[320px] px-4 py-3 text-sm text-muted-foreground">{policy.description}</td>
                <td className="px-4 py-3 text-right"><StatusBadge status={policy.enabled ? 'active' : 'disabled'} size="sm" /></td>
                <td className="px-4 py-3 text-right font-mono text-sm text-muted-foreground">{policy.value}</td>
                <td className="px-4 py-3 text-right text-sm text-muted-foreground">{formatRelativeTime(policy.updatedAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {filtered.length === 0 && <div className="border-t py-12 text-center text-sm text-muted-foreground">No policies match your filters.</div>}
      </div>
    </div>
  );
}
