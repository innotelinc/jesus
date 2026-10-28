import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMetricsPolling } from '../hooks/useMetricsPolling';
import { formatBytes } from '../lib/utils';
import Chart from '../components/Chart';

type TimeRange = '24h' | '7d' | '30d';

const snapshotCards = [
  { label: 'CPU', value: (s: { cpuPercent: number }) => `${s.cpuPercent}%`, color: 'bg-primary', icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4"><rect x="4" y="4" width="16" height="16" rx="2" /><path d="M9 9h6v6H9z" /></svg> },
  { label: 'Memory', value: (s: { memoryPercent: number }) => `${s.memoryPercent}%`, color: 'bg-accent', icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4"><rect x="2" y="4" width="20" height="16" rx="2" /><path d="M12 4v16" /></svg> },
  { label: 'Disk', value: (s: { diskPercent: number }) => `${s.diskPercent}%`, color: 'bg-warning', icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4"><circle cx="12" cy="12" r="10" /><path d="M2 12h20" /><path d="M12 2a15 15 0 0 1 0 20" /><path d="M12 2a15 15 0 0 0 0 20" /></svg> },
  { label: 'Network In', value: (s: { networkIn: number }) => formatBytes(s.networkIn), color: 'bg-info', icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4"><path d="M22 12h-4l-3 9L9 3l-3 9H2" /></svg> },
  { label: 'Network Out', value: (s: { networkOut: number }) => formatBytes(s.networkOut), color: 'bg-info', icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4"><path d="M2 12h4l3-9L15 3l3 9H22" /></svg> },
  { label: 'Request Rate', value: (s: { requestRate: number }) => `${s.requestRate.toLocaleString()} req/s`, color: 'bg-primary', icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4"><path d="M3 3v18h18" /><path d="m19 9-5 5-4-4-3 3" /></svg> },
  { label: 'Error Rate', value: (s: { errorRate: number }) => `${s.errorRate.toFixed(2)}%`, color: (s: { errorRate: number }) => s.errorRate >= 5 ? 'bg-danger' : s.errorRate >= 1 ? 'bg-warning' : 'bg-success', icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4"><circle cx="12" cy="12" r="10" /><path d="M12 8v4" /><path d="M12 16h.01" /></svg> },
  { label: 'Active Sessions', value: (s: { activeSessions: number }) => s.activeSessions.toString(), color: 'bg-accent', icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M23 21v-2a4 4 0 0 0-3-3.87" /><path d="M16 3.13a4 4 0 0 1 0 7.75" /></svg> },
];

type Snapshot = ReturnType<typeof useMetricsPolling>['snapshot'];

function snapshotDestination(label: string, snapshot: Snapshot): { to: string; title: string } | null {
  const resource = label === 'CPU'
    ? snapshot.cpuPercent
    : label === 'Memory'
      ? snapshot.memoryPercent
      : label === 'Disk'
        ? snapshot.diskPercent
        : null;
  if (resource !== null && resource >= 80) {
    const status = resource >= 90 ? 'critical' : 'warning';
    return { to: `/services?status=${status}`, title: `View ${status} services` };
  }
  if (label === 'Error Rate' && snapshot.errorRate >= 1) {
    const severity = snapshot.errorRate >= 5 ? 'critical' : 'warning';
    return { to: `/alerts?severity=${severity}&status=open`, title: `View open ${severity} alerts` };
  }
  return null;
}

function snapshotPercent(label: string, snapshot: Snapshot): number {
  if (label === 'CPU') return Math.min(100, snapshot.cpuPercent);
  if (label === 'Memory') return Math.min(100, snapshot.memoryPercent);
  if (label === 'Disk') return Math.min(100, snapshot.diskPercent);
  if (label === 'Error Rate') return Math.min(100, snapshot.errorRate * 10);
  if (label === 'Request Rate') return Math.min(100, snapshot.requestRate / 100);
  if (label === 'Active Sessions') return Math.min(100, snapshot.activeSessions / 5);
  if (label === 'Network In') return Math.min(100, snapshot.networkIn / 3_000_000);
  return Math.min(100, snapshot.networkOut / 2_000_000);
}

const chartConfigs = (metrics: ReturnType<typeof useMetricsPolling>['metrics']) => [
  { key: 'cpu' as const, label: 'CPU %', color: 'hsl(var(--primary))', data: metrics.cpu, formatY: (v: number) => `${v.toFixed(0)}%` },
  { key: 'memory' as const, label: 'Memory %', color: 'hsl(var(--accent))', data: metrics.memory, formatY: (v: number) => `${v.toFixed(0)}%` },
  { key: 'disk' as const, label: 'Disk %', color: 'hsl(var(--warning))', data: metrics.disk, formatY: (v: number) => `${v.toFixed(0)}%` },
  { key: 'networkIn' as const, label: 'Network In', color: 'hsl(var(--info))', data: metrics.networkIn, formatY: (v: number) => formatBytes(v) },
  { key: 'networkOut' as const, label: 'Network Out', color: 'hsl(var(--info))', data: metrics.networkOut, formatY: (v: number) => formatBytes(v) },
  { key: 'requestRate' as const, label: 'Request Rate', color: 'hsl(var(--primary))', data: metrics.requestRate, formatY: (v: number) => `${v.toLocaleString()}` },
  { key: 'errorRate' as const, label: 'Error Rate %', color: 'hsl(var(--danger))', data: metrics.errorRate, formatY: (v: number) => `${v.toFixed(2)}%` },
  { key: 'activeSessions' as const, label: 'Active Sessions', color: 'hsl(var(--accent))', data: metrics.activeSessions, formatY: (v: number) => v.toFixed(0) },
];

export default function Monitoring() {
  const [range, setRange] = useState<TimeRange>('24h');
  const { snapshot, metrics, state, lastRefreshed, refresh } = useMetricsPolling({ intervalMs: 30_000 });

  const resolvedRange = range === '24h' ? 24 : range === '7d' ? 7 : 30;
  const intervalLabel = state === 'error' ? 'offline' : '30s';

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Monitoring</h1>
          <p className="mt-1 text-sm text-muted-foreground">Live system metrics, resource utilization, and request/error trends.</p>
        </div>
        <div className="flex items-center gap-2">
          {(['24h', '7d', '30d'] as TimeRange[]).map(r => (
            <button
              key={r}
              onClick={() => setRange(r)}
              className={`rounded-full px-4 py-1.5 text-sm font-medium transition-colors ${range === r ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground hover:text-foreground'}`}
            >
              {r === '24h' ? '24h trend' : r === '7d' ? '7-day trend' : '30-day trend'}
            </button>
          ))}
          <button
            onClick={refresh}
            className="rounded-lg border bg-muted px-3 py-1.5 text-sm text-muted-foreground hover:text-foreground disabled:opacity-50"
            disabled={state === 'loading'}
          >
            Refresh now
          </button>
        </div>
      </div>

      <div>
        <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">Current Resource Snapshot</h2>
        <div className="mt-3 grid gap-4 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-8">
          {snapshotCards.map(card => {
            const destination = snapshotDestination(card.label, snapshot);
            const color = typeof card.color === 'function' ? card.color(snapshot) : card.color;
            const content = (
              <>
                <div className="flex items-start justify-between">
                  <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{card.label}</p>
                  <div className={`flex h-9 w-9 items-center justify-center rounded-lg ${color}`}>
                    {card.icon}
                  </div>
                </div>
                <div className="mt-3 flex items-end justify-between gap-2">
                  <span className="text-2xl font-semibold">{typeof card.value === 'function' ? card.value(snapshot) : card.value}</span>
                  {destination && <span className="text-[10px] font-medium text-primary">Investigate →</span>}
                </div>
                <div className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-muted">
                  <div className={`h-full rounded-full transition-[width] duration-500 ${color}`} style={{ width: `${snapshotPercent(card.label, snapshot)}%` }} />
                </div>
              </>
            );
            const className = 'block rounded-2xl border bg-card p-5 shadow-sm transition-all hover:-translate-y-0.5 hover:border-primary/40 hover:shadow-md';
            return destination ? (
              <Link key={card.label} to={destination.to} title={destination.title} className={className}>
                {content}
              </Link>
            ) : (
              <div key={card.label} className={className}>{content}</div>
            );
          })}
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        {chartConfigs(metrics).map(cfg => (
          <div key={cfg.key} className="rounded-2xl border bg-card shadow-sm p-4">
            <div className="flex items-center justify-between mb-2">
              <span className="text-sm font-medium">{cfg.label}</span>
              <span className="text-xs text-muted-foreground">{range}</span>
            </div>
            <Chart
              data={cfg.data.slice(0, resolvedRange)}
              color={cfg.color}
              height={120}
              formatY={cfg.formatY}
              showArea
            />
          </div>
        ))}
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="rounded-2xl border bg-card shadow-sm p-5">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">Network Traffic Combined</h2>
            <span className="text-xs text-muted-foreground">{range}</span>
          </div>
          <div className="flex gap-3" style={{ height: 150 }}>
            <div className="flex-1">
              <Chart data={metrics.networkIn.slice(0, resolvedRange)} color="hsl(var(--info))" height={150} showArea />
            </div>
            <div className="flex-1">
              <Chart data={metrics.networkOut.slice(0, resolvedRange)} color="hsl(var(--primary))" height={150} showArea />
            </div>
          </div>
        </div>
        <div className="rounded-2xl border bg-card shadow-sm p-5">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">Errors vs Requests</h2>
            <span className="text-xs text-muted-foreground">{range}</span>
          </div>
          <div className="flex gap-3" style={{ height: 150 }}>
            <div className="flex-1">
              <Chart data={metrics.errorRate.slice(0, resolvedRange)} color="hsl(var(--danger))" height={150} showArea />
            </div>
            <div className="flex-1">
              <Chart data={metrics.requestRate.slice(0, resolvedRange)} color="hsl(var(--primary))" height={150} showArea />
            </div>
          </div>
        </div>
      </div>

      <div className="flex items-center justify-between border-t pt-4">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          {state === 'loading' ? (
            <>
              <span className="inline-flex h-2 w-2 rounded-full bg-info animate-pulse-slow" />
              <span>Refreshing telemetry…</span>
            </>
          ) : state === 'stale' ? (
            <>
              <span className="inline-flex h-2 w-2 rounded-full bg-warning animate-pulse-slow" />
              <span>Showing fallback sample data; live telemetry endpoint unavailable.</span>
            </>
          ) : state === 'error' ? (
            <>
              <span className="inline-flex h-2 w-2 rounded-full bg-danger animate-pulse-slow" />
              <span>Telemetry endpoint unreachable; using last-known snapshot.</span>
            </>
          ) : (
            <>
              <span className="inline-flex h-2 w-2 rounded-full bg-success animate-pulse-slow" />
              <span>Live feed connected; polling every {intervalLabel}.</span>
            </>
          )}
          {lastRefreshed && (
            <span className="ml-2 text-xs text-muted-foreground">
              Last refreshed {new Date(lastRefreshed).toLocaleTimeString()}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span className="inline-flex h-2 w-2 rounded-full bg-success animate-pulse-slow" />
          Data refresh: {intervalLabel}
        </div>
      </div>
    </div>
  );
}
