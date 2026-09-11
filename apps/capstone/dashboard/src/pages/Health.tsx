import { useCallback, useEffect, useState, useMemo } from 'react';
import type { HealthMatrixEntry, StackAccessStatus } from '../types';
import { api } from '../lib/api';
import { useDashboardData } from '../context/DashboardDataContext';
import StatusBadge from '../components/StatusBadge';
import Button from '../components/Button';
import { cn } from '../lib/utils';
import Chart from '../components/Chart';
import type { MetricPoint } from '../types';

function healthColor(status: string) {
  switch (status) {
    case 'healthy':
      return 'bg-success text-success-foreground border-success/40';
    case 'warning':
      return 'bg-warning text-warning-foreground border-warning/40';
    case 'critical':
      return 'bg-danger text-danger-foreground border-danger/40';
    default:
      return 'bg-muted text-muted-foreground border-muted';
  }
}

function healthRowColor(entry: HealthMatrixEntry) {
  if (entry.status === 'healthy') return 'text-success';
  if (entry.status === 'warning') return 'text-warning';
  if (entry.status === 'critical') return 'text-danger';
  return 'text-muted-foreground';
}

const uptimePoints: MetricPoint[] = Array.from({ length: 30 }, (_, i) => ({
  timestamp: new Date(Date.now() - (30 - i) * 24 * 60 * 60 * 1000).toISOString(),
  value: 98.5 + (i % 7 === 0 ? -0.5 : (i % 5 === 0 ? 0.3 : 0)),
}));

export default function Health() {
  const { healthData, incidents } = useDashboardData();
  const [checkFilter, setCheckFilter] = useState('all');

  const [stackAccess, setStackAccess] = useState<StackAccessStatus | null>(null);
  const [accessLoading, setAccessLoading] = useState(false);

  // Stack SSO/access is a separate, slower call (it talks to the IdP), so it is
  // fetched on its own instead of blocking the main dashboard payload.
  const loadStackAccess = useCallback(async () => {
    setAccessLoading(true);
    try {
      setStackAccess(await api.authentikAccess());
    } catch {
      setStackAccess(null);
    } finally {
      setAccessLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadStackAccess();
  }, [loadStackAccess]);

  const filtered = useMemo(() => {
    if (checkFilter === 'all') return healthData;
    return healthData.filter(e => e.status === checkFilter);
  }, [checkFilter, healthData]);

  // Only stacks with a real login flow to gate are columns in the matrix — a
  // tiles-only stack has nothing to be granted or denied.
  const gatedStacks = useMemo(
    () => (stackAccess?.stacks ?? []).filter(s => s.applications > 0),
    [stackAccess],
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Health & Status</h1>
          <p className="mt-1 text-sm text-muted-foreground">Real-time service health matrix, latency, error rates, and dependency map.</p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="7 10 12 15 17 10" /><path d="M12 15V3" /></svg>
            Export
          </Button>
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        {['all', 'healthy', 'warning', 'critical', 'offline'].map(f => (
          <button
            key={f}
            onClick={() => setCheckFilter(f)}
            className={cn(
              'rounded-full px-3 py-1 text-xs font-medium transition-colors',
              checkFilter === f ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground hover:text-foreground',
            )}
          >
            {f === 'all' ? 'All' : f.charAt(0).toUpperCase() + f.slice(1)}
          </button>
        ))}
      </div>

      <div className="border rounded-2xl bg-card shadow-sm overflow-hidden">
        <table className="w-full border-collapse">
          <thead>
            <tr className="border-b bg-muted/30">
              <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-muted-foreground">Service</th>
              <th className="px-4 py-3 text-right text-xs font-semibold uppercase tracking-wider text-muted-foreground">Health %</th>
              <th className="px-4 py-3 text-right text-xs font-semibold uppercase tracking-wider text-muted-foreground">Availability %</th>
              <th className="px-4 py-3 text-right text-xs font-semibold uppercase tracking-wider text-muted-foreground">Latency</th>
              <th className="px-4 py-3 text-right text-xs font-semibold uppercase tracking-wider text-muted-foreground">Error Rate</th>
              <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-muted-foreground">Dependencies</th>
              <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-muted-foreground">Last Check</th>
              <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-muted-foreground w-[120px]">Status</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {filtered.map((entry, idx) => (
              <tr key={idx} className="hover:bg-muted/40 transition-colors">
                <td className="px-4 py-3">
                  <div className="flex items-center gap-2">
                    <div className={cn('h-2 w-2 rounded-full', healthRowColor(entry))} />
                    <span className="font-medium">{entry.service}</span>
                  </div>
                </td>
                <td className="px-4 py-3 text-right">
                  <div className="flex items-center justify-end gap-2">
                    <span className={cn('font-medium', healthRowColor(entry))}>{entry.health.toFixed(0)}%</span>
                    <div className="h-1.5 w-16 overflow-hidden rounded-full bg-muted">
                      <div className={cn('h-full rounded-full', healthRowColor(entry))} style={{ width: `${entry.health}%` }} />
                    </div>
                  </div>
                </td>
                <td className="px-4 py-3 text-right font-medium">{entry.availability.toFixed(2)}%</td>
                <td className="px-4 py-3 text-right">{entry.latencyMs > 0 ? `${entry.latencyMs}ms` : '—'}</td>
                <td className="px-4 py-3 text-right">
                  <span className={cn('font-medium', entry.errorRate > 1 ? 'text-danger' : entry.errorRate > 0.5 ? 'text-warning' : 'text-muted-foreground')}>
                    {entry.errorRate > 0 ? `${entry.errorRate}%` : '0%'}
                  </span>
                </td>
                <td className="px-4 py-3">
                  <div className="flex flex-wrap gap-1">
                    {entry.dependencies.length ? entry.dependencies.map(d => (
                      <span key={d} className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">{d}</span>
                    )) : <span className="text-muted-foreground">—</span>}
                  </div>
                </td>
                <td className="px-4 py-3 text-sm text-muted-foreground">Just now</td>
                <td className="px-4 py-3">
                  <span className={cn('inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium border', healthRowColor(entry))} style={{ borderColor: `hsl(var(--${healthRowColor(entry).replace('text-', '')}) / 0.3)` }}>
                    <span className={cn('h-2 w-2 rounded-full', healthRowColor(entry))} />
                    {entry.status}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {filtered.length === 0 && (
          <div className="flex flex-col items-center justify-center py-12 border-t text-center">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="mx-auto h-8 w-8 text-muted-foreground"><circle cx="12" cy="12" r="10" /><path d="M16 16s-1.5-2-4-2-4 2-4 2" /><line x1="9" y1="9" x2="9.01" y2="9" /><line x1="15" y1="9" x2="15.01" y2="9" /></svg>
            <p className="mt-2 text-sm font-medium">No services match the selected status.</p>
          </div>
        )}
      </div>

      {/* Stack SSO & access — which Cerulean Authentik identity can reach which
          stack, and whether a group binding actually enforces it. */}
      <div>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">Stack SSO &amp; access</h2>
            <p className="mt-1 text-xs text-muted-foreground">
              Which identity can reach which stack, and whether a group binding gates it.
            </p>
          </div>
          <Button variant="outline" size="sm" onClick={() => void loadStackAccess()} disabled={accessLoading}>
            {accessLoading ? 'Re-checking…' : 'Re-check'}
          </Button>
        </div>

        <div className="mt-2">
          {stackAccess === null ? (
            <div className="border rounded-2xl bg-card shadow-sm p-4 text-sm text-muted-foreground">
              {accessLoading ? 'Reading Authentik…' : 'Stack access inventory unavailable.'}
            </div>
          ) : !stackAccess.ok ? (
            <div className="border rounded-2xl bg-card shadow-sm p-4">
              <p className="text-sm font-medium text-warning">Couldn't read the Authentik access inventory</p>
              <p className="mt-1 text-xs text-muted-foreground">{stackAccess.error || 'The identity provider did not answer.'}</p>
              <p className="mt-1 text-xs text-muted-foreground">
                The Control Center needs <code>AUTHENTIK_TOKEN</code> (and <code>AUTHENTIK_PUBLIC_URL</code> or{' '}
                <code>AUTHENTIK_API_URL</code> when the IdP is not reachable at auth.&lt;domain&gt;).
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              <div className="flex flex-wrap gap-2">
                {[
                  `${stackAccess.summary.stacks} stacks`,
                  `${stackAccess.summary.applications} applications`,
                  `${stackAccess.summary.enforced} gated`,
                  `${stackAccess.summary.ungated} open`,
                  `${stackAccess.summary.users} identities`,
                ].map(chip => (
                  <span key={chip} className="rounded-full bg-muted px-3 py-1 text-xs font-medium text-muted-foreground">{chip}</span>
                ))}
              </div>

              {stackAccess.ungated.length > 0 && (
                <div className="rounded-2xl border border-warning/40 bg-warning/8 p-4">
                  <p className="text-sm font-medium text-warning">
                    {stackAccess.ungated.length} application{stackAccess.ungated.length === 1 ? '' : 's'} not gated — every signed-in user can reach {stackAccess.ungated.length === 1 ? 'it' : 'them'}
                  </p>
                  <div className="mt-2 flex flex-wrap gap-1">
                    {stackAccess.ungated.map(app => (
                      <span key={app.slug} className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">{app.slug} · {app.stack}</span>
                    ))}
                  </div>
                </div>
              )}

              <div className="border rounded-2xl bg-card shadow-sm overflow-hidden">
                <table className="w-full border-collapse">
                  <thead>
                    <tr className="border-b bg-muted/30">
                      <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-muted-foreground">Stack</th>
                      <th className="px-4 py-3 text-right text-xs font-semibold uppercase tracking-wider text-muted-foreground">Applications</th>
                      <th className="px-4 py-3 text-right text-xs font-semibold uppercase tracking-wider text-muted-foreground">Gated</th>
                      <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-muted-foreground">Members</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {stackAccess.stacks.map(stack => (
                      <tr key={stack.name} className="hover:bg-muted/40 transition-colors">
                        <td className="px-4 py-3 font-medium">{stack.name}</td>
                        <td className="px-4 py-3 text-right">{stack.applications}</td>
                        <td className="px-4 py-3 text-right">
                          {stack.applications === 0 ? (
                            <span className="text-xs text-muted-foreground">tiles only</span>
                          ) : (
                            <span className={cn('font-medium', stack.enforced === stack.applications ? 'text-success' : 'text-warning')}>
                              {stack.enforced}/{stack.applications}
                            </span>
                          )}
                        </td>
                        <td className="px-4 py-3">
                          <div className="flex flex-wrap gap-1">
                            {stack.members.length ? stack.members.map(m => (
                              <span key={m} className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">{m}</span>
                            )) : <span className="text-xs text-muted-foreground">—</span>}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="border rounded-2xl bg-card shadow-sm overflow-x-auto">
                <table className="w-full border-collapse text-xs">
                  <thead>
                    <tr className="border-b bg-muted/30">
                      <th className="sticky left-0 bg-card px-3 py-2 text-left text-xs font-semibold uppercase tracking-wider text-muted-foreground">Identity</th>
                      {gatedStacks.map(stack => (
                        <th key={stack.name} className="px-2 py-2 text-center text-xs font-semibold uppercase tracking-wider text-muted-foreground whitespace-nowrap">{stack.name}</th>
                      ))}
                      <th className="px-3 py-2 text-right text-xs font-semibold uppercase tracking-wider text-muted-foreground">Reaches</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {stackAccess.users.map(u => (
                      <tr key={u.username} className="hover:bg-muted/40 transition-colors">
                        <td className="sticky left-0 bg-card px-3 py-2">
                          <div className="font-medium">{u.username}</div>
                          <div className="text-[10px] text-muted-foreground">
                            {u.superuser ? 'superuser' : u.machine ? 'machine account' : u.type}
                          </div>
                        </td>
                        {gatedStacks.map(stack => (
                          <td key={stack.name} className="px-2 py-2 text-center">
                            {u.stacks.includes(stack.name)
                              ? <span className="text-success" title="reachable">●</span>
                              : <span className="text-muted-foreground/40" title="denied">·</span>}
                          </td>
                        ))}
                        <td className={cn('px-3 py-2 text-right font-medium', u.stacks.length === 0 ? 'text-danger' : 'text-muted-foreground')}>
                          {u.stacks.length}/{gatedStacks.length}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <p className="text-xs text-muted-foreground">
                ● reachable · denied{stackAccess.tilesOnly.length > 0
                  ? ` · portal tiles without a provider (nothing to gate): ${stackAccess.tilesOnly.join(', ')}`
                  : ''}
              </p>
            </div>
          )}
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <div>
          <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">Historical Uptime</h2>
          <div className="mt-2 border rounded-2xl bg-card shadow-sm p-4">
            <Chart data={uptimePoints} color="hsl(var(--success))" height={160} formatY={v => `${v.toFixed(1)}%`} showArea />
          </div>
        </div>
        <div>
          <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">Top Error Rates</h2>
          <div className="mt-2 border rounded-2xl bg-card shadow-sm p-4">
            <div className="space-y-3">
              {healthData.sort((a, b) => b.errorRate - a.errorRate).slice(0, 5).map((entry, i) => (
                <div key={i} className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2 truncate">
                    <span className={cn('h-2 w-2 rounded-full shrink-0', healthRowColor(entry))} />
                    <span className="text-sm truncate">{entry.service}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-muted-foreground">{entry.errorRate}%</span>
                    <div className="h-2 w-20 overflow-hidden rounded-full bg-muted">
                      <div className={cn('h-full rounded-full', healthRowColor(entry))} style={{ width: `${Math.min(100, entry.errorRate * 50)}%` }} />
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
        <div>
          <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">Dependency Map</h2>
          <div className="mt-2 border rounded-2xl bg-card shadow-sm p-4">
            <div className="flex flex-wrap gap-2">
              {healthData.map(entry => (
                <div key={entry.service} className={cn('rounded-lg border p-3 text-sm', entry.status === 'healthy' ? 'bg-success/8 border-success/30' : entry.status === 'warning' ? 'bg-warning/8 border-warning/30' : 'bg-danger/8 border-danger/30')}>
                  <div className="font-medium">{entry.service}</div>
                  <div className="mt-1 flex flex-wrap gap-1 text-xs text-muted-foreground">
                    {entry.dependencies.length ? entry.dependencies.map(d => (
                      <span key={d} className="rounded-full bg-muted/60 px-1.5 py-0.5">{d}</span>
                    )) : <span className="text-muted-foregroundColor">none</span>}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      <div>
        <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">Incident Timeline</h2>
        <div className="mt-2 border rounded-2xl bg-card shadow-sm overflow-hidden">
          <table className="w-full border-collapse">
            <thead>
              <tr className="border-b bg-muted/30">
                <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-muted-foreground">Time</th>
                <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-muted-foreground">Title</th>
                <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-muted-foreground">Status</th>
                <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-muted-foreground">Severity</th>
                <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-muted-foreground">Affected</th>
                <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-muted-foreground">Resolved</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {incidents.map((inc, idx) => (
                <tr key={idx} className="hover:bg-muted/40 transition-colors">
                  <td className="px-4 py-3 text-sm text-muted-foreground">{inc.time}</td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <div className={cn('h-2 w-2 rounded-full', healthColor(inc.severity).split(' ')[0].replace('bg-', ''))} />
                      <span className="font-medium">{inc.title}</span>
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <span className={cn('inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium', inc.status === 'resolved' ? 'bg-success/20 text-success' : 'bg-danger/20 text-danger')}>
                      {inc.status}
                    </span>
                  </td>
                  <td className="px-4 py-3"><StatusBadge status={inc.severity as 'warning' | 'info' | 'critical'} size="sm" /></td>
                  <td className="px-4 py-3 text-sm text-muted-foreground">{inc.affected.join(', ')}</td>
                  <td className="px-4 py-3 text-sm text-muted-foreground">{inc.resolvedAt || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
