import { useCallback, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import type { Service } from '../types';
import { useDashboardData } from '../context/DashboardDataContext';
import { useMetricsPolling } from '../hooks/useMetricsPolling';
import KpiCard from '../components/KpiCard';
import StatusBadge from '../components/StatusBadge';
import ServiceCard from '../components/ServiceCard';
import ServiceDetailDrawer, { type ServiceTab } from '../components/ServiceDetailDrawer';
import Button from '../components/Button';
import { cn, formatBytes, formatRelativeTime } from '../lib/utils';

function HealthRing({ pct, size = 84 }: { pct: number; size?: number }) {
  const stroke = 7;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const filled = Math.max(0, Math.min(100, pct));
  const color = filled >= 95 ? 'hsl(var(--success))' : filled >= 85 ? 'hsl(var(--warning))' : 'hsl(var(--danger))';
  return (
    <div className="relative shrink-0" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="hsl(var(--muted))" strokeWidth={stroke} />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={color}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={`${(filled / 100) * c} ${c}`}
          className="transition-all duration-700 ease-out"
        />
      </svg>
      <div className="absolute inset-0 flex items-center justify-center">
        <span className="text-lg font-bold tracking-tight">{Math.round(filled)}%</span>
      </div>
    </div>
  );
}

function Meter({ label, value, pct, barClass }: { label: string; value: string; pct: number; barClass: string }) {
  const clamped = Math.max(0, Math.min(100, pct));
  return (
    <div>
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-xs text-muted-foreground">{label}</span>
        <span className="font-mono text-xs font-medium text-foreground">{value}</span>
      </div>
      <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-muted">
        <div className={cn('h-full rounded-full transition-all duration-700 ease-out', barClass)} style={{ width: `${clamped}%` }} />
      </div>
    </div>
  );
}

const quickLinks = [
  { label: 'Services', to: '/services', icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-3.5 w-3.5"><rect x="2" y="3" width="20" height="14" rx="2" /><path d="M8 21h8" /><path d="M12 17v4" /></svg> },
  { label: 'Monitoring', to: '/monitoring', icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-3.5 w-3.5"><path d="M3 3v18h18" /><path d="m19 9-5 5-4-4-3 3" /></svg> },
  { label: 'Health & Status', to: '/health', icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-3.5 w-3.5"><path d="M22 12h-4l-3 9L9 3l-3 9H2" /></svg> },
  { label: 'Softphone', to: '/softphone', icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-3.5 w-3.5"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z" /></svg> },
  { label: 'Secrets Vault', to: '/secrets', icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-3.5 w-3.5"><rect x="3" y="11" width="18" height="11" rx="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" /></svg> },
];

export default function Dashboard() {
  const { services, dashboardStats, alerts, state: dataState, lastRefreshed, refresh } = useDashboardData();
  const { snapshot, state: snapshotState, refresh: refreshSnapshot } = useMetricsPolling({ intervalMs: 15_000 });
  const navigate = useNavigate();

  const [selected, setSelected] = useState<Service | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [drawerTab, setDrawerTab] = useState<ServiceTab>('overview');
  const [autoRestart, setAutoRestart] = useState(false);

  const openService = useCallback((service: Service, tab: ServiceTab) => {
    setSelected(service);
    setDrawerTab(tab);
    setAutoRestart(false);
    setDrawerOpen(true);
  }, []);

  const restartService = useCallback((service: Service) => {
    setSelected(service);
    setDrawerTab('overview');
    setAutoRestart(true);
    setDrawerOpen(true);
  }, []);

  const openMetrics = useCallback((service: Service) => {
    // Per-service time series live on the monitoring page (global feed).
    void service;
    navigate('/monitoring');
  }, [navigate]);

  const closeDrawer = useCallback(() => {
    setDrawerOpen(false);
    setSelected(null);
  }, []);

  const total = dashboardStats.totalServices;
  const healthy = dashboardStats.healthyServices;
  const healthPct = total > 0 ? (healthy / total) * 100 : 0;

  const feedState =
    dataState === 'loading' ? 'loading'
      : dataState === 'live' && snapshotState === 'live' ? 'live'
      : snapshotState === 'stale' ? 'stale'
      : 'offline';
  const feedDot =
    feedState === 'live' ? 'bg-success' : feedState === 'stale' ? 'bg-warning' : feedState === 'loading' ? 'bg-info' : 'bg-danger';
  const feedLabel =
    feedState === 'live' ? 'Live' : feedState === 'stale' ? 'Fallback data' : feedState === 'loading' ? 'Loading' : 'Offline';

  const openAlerts = alerts.filter(a => a.status === 'open');

  return (
    <div className="space-y-6">
      {/* ── Hero: system status ─────────────────────────────────────────── */}
      <section className="relative overflow-hidden rounded-2xl border bg-gradient-to-br from-primary/20 via-card to-card p-6 sm:p-7">
        <div className="pointer-events-none absolute -right-24 -top-24 h-72 w-72 rounded-full bg-primary/10 blur-3xl" />
        <div className="relative flex flex-wrap items-center gap-6">
          <HealthRing pct={healthPct} />
          <div className="min-w-0 flex-1">
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-primary">System Status</p>
            <h1 className="mt-1.5 text-2xl font-bold tracking-tight sm:text-3xl">
              {healthPct >= 95 ? 'All systems operational' : healthPct >= 85 ? 'Mostly operational' : 'Attention required'}
            </h1>
            <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1.5 text-sm text-muted-foreground">
              <span><span className="font-semibold text-foreground">{healthy}</span> healthy</span>
              <span><span className="font-semibold text-warning">{dashboardStats.warningServices}</span> warning</span>
              <span><span className="font-semibold text-danger">{dashboardStats.criticalServices}</span> critical</span>
              <span><span className="font-semibold text-foreground">{openAlerts.length}</span> open alerts</span>
            </div>
          </div>
          <div className="flex shrink-0 flex-col items-end gap-2.5">
            <span className={cn('inline-flex items-center gap-2 rounded-full border bg-background/60 px-3 py-1.5 text-xs font-medium text-muted-foreground backdrop-blur')}>
              <span className={cn('h-2 w-2 rounded-full animate-pulse-slow', feedDot)} />
              {feedLabel}
              {lastRefreshed && feedState !== 'loading' && (
                <span className="hidden sm:inline text-muted-foreground/70">· {new Date(lastRefreshed).toLocaleTimeString()}</span>
              )}
            </span>
            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm" onClick={() => window.print()}>
                Export
              </Button>
              <Button size="sm" disabled={dataState === 'loading'} onClick={() => { void refresh(); void refreshSnapshot(); }}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-3.5 w-3.5"><path d="M3 3v18h18" /><path d="m19 9-5 5-4-4-3 3" /></svg>
                Refresh
              </Button>
            </div>
          </div>
        </div>
        <div className="relative mt-6 flex flex-wrap gap-2 border-t border-border/60 pt-5">
          {quickLinks.map(link => (
            <Link
              key={link.to}
              to={link.to}
              className="inline-flex items-center gap-2 rounded-full border bg-background/60 px-3.5 py-1.5 text-xs font-medium text-muted-foreground backdrop-blur transition-colors hover:border-primary/40 hover:text-foreground"
            >
              {link.icon}
              {link.label}
            </Link>
          ))}
        </div>
      </section>

      {/* ── KPI row ─────────────────────────────────────────────────────── */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <KpiCard
          title="Total Services"
          value={total}
          subtitle={`${services.length} tracked`}
          icon={<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-5 w-5"><rect x="2" y="3" width="20" height="14" rx="2" /><path d="M8 21h8" /><path d="M12 17v4" /></svg>}
        />
        <KpiCard
          title="Healthy"
          value={healthy}
          subtitle="Passing health checks"
          color="success"
          icon={<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-5 w-5"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" /><polyline points="22 4 12 14.01 9 11.01" /></svg>}
        />
        <KpiCard
          title="Warning"
          value={dashboardStats.warningServices}
          subtitle="Attention required"
          color="warning"
          icon={<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-5 w-5"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" /><path d="M12 9v4" /><path d="M12 17h.01" /></svg>}
        />
        <KpiCard
          title="Critical"
          value={dashboardStats.criticalServices}
          subtitle="Immediate action"
          color="danger"
          icon={<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-5 w-5"><circle cx="12" cy="12" r="10" /><path d="M12 8v4" /><path d="M12 16h.01" /></svg>}
        />
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <KpiCard
          title="Active Ports"
          value={dashboardStats.activePorts}
          subtitle={`${services.length} services exposed`}
          icon={<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-5 w-5"><circle cx="12" cy="12" r="3" /><circle cx="19" cy="5" r="2" /><circle cx="5" cy="5" r="2" /><circle cx="5" cy="19" r="2" /><circle cx="19" cy="19" r="2" /></svg>}
        />
        <KpiCard
          title="Open Alerts"
          value={openAlerts.length}
          subtitle="Requires attention"
          color="warning"
          icon={<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-5 w-5"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" /><path d="M12 9v4" /><path d="M12 17h.01" /></svg>}
        />
        <KpiCard
          title="Expiring Secrets"
          value={dashboardStats.expiringSecrets}
          subtitle="Within 7 days"
          color="info"
          icon={<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-5 w-5"><rect x="3" y="11" width="18" height="11" rx="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" /></svg>}
        />
        <KpiCard
          title="System Uptime"
          value={`${(dashboardStats.uptimePercent ?? 0).toFixed(2)}%`}
          subtitle="Last 30 days"
          color="success"
          icon={<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-5 w-5"><circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" /></svg>}
        />
      </div>

      {/* ── Services ────────────────────────────────────────────────────── */}
      <div>
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold tracking-tight">Services</h2>
          <Link to="/services" className="text-sm text-primary hover:underline">View all {services.length} →</Link>
        </div>
        <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {services.map((service: Service, index) => (
            <div key={service.id} className="animate-in" style={{ animationDelay: `${Math.min(index * 30, 300)}ms` }}>
              <ServiceCard
                service={service}
                index={index}
                onOpen={openService}
                onRestart={restartService}
                onMetrics={openMetrics}
              />
            </div>
          ))}
        </div>
      </div>

      {/* ── Snapshot + alerts ───────────────────────────────────────────── */}
      <div className="grid gap-4 lg:grid-cols-2">
        <div className="rounded-2xl border bg-card p-5 shadow-sm">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">Resource Snapshot</h2>
            <span className="text-xs text-muted-foreground">live · 15s</span>
          </div>
          <div className="mt-5 grid grid-cols-1 gap-x-8 gap-y-4 sm:grid-cols-2">
            <Meter label="CPU" value={`${snapshot.cpuPercent.toFixed(1)}%`} pct={snapshot.cpuPercent} barClass="bg-gradient-to-r from-primary to-primary/60" />
            <Meter label="Memory" value={`${snapshot.memoryPercent.toFixed(1)}%`} pct={snapshot.memoryPercent} barClass="bg-gradient-to-r from-accent to-accent/60" />
            <Meter label="Disk" value={`${snapshot.diskPercent.toFixed(1)}%`} pct={snapshot.diskPercent} barClass="bg-gradient-to-r from-warning to-warning/60" />
            <Meter label="Error Rate" value={`${snapshot.errorRate.toFixed(2)}%`} pct={Math.min(100, snapshot.errorRate * 10)} barClass={snapshot.errorRate > 1 ? 'bg-gradient-to-r from-danger to-danger/60' : 'bg-gradient-to-r from-success to-success/60'} />
            <div className="flex items-baseline justify-between border-t border-border pt-3 text-xs">
              <span className="text-muted-foreground">Network In</span>
              <span className="font-mono font-medium text-foreground">{formatBytes(snapshot.networkIn)}/s</span>
            </div>
            <div className="flex items-baseline justify-between border-t border-border pt-3 text-xs">
              <span className="text-muted-foreground">Network Out</span>
              <span className="font-mono font-medium text-foreground">{formatBytes(snapshot.networkOut)}/s</span>
            </div>
            <div className="flex items-baseline justify-between border-t border-border pt-3 text-xs">
              <span className="text-muted-foreground">Request Rate</span>
              <span className="font-mono font-medium text-foreground">{snapshot.requestRate.toLocaleString()} req/s</span>
            </div>
            <div className="flex items-baseline justify-between border-t border-border pt-3 text-xs">
              <span className="text-muted-foreground">Active Sessions</span>
              <span className="font-mono font-medium text-foreground">{snapshot.activeSessions}</span>
            </div>
          </div>
        </div>

        <div className="rounded-2xl border bg-card shadow-sm">
          <div className="flex items-center justify-between border-b border-border px-5 py-4">
            <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">Recent Alerts</h2>
            <Link to="/alerts" className="text-xs text-primary hover:underline">View all</Link>
          </div>
          {openAlerts.length === 0 ? (
            <div className="flex items-center gap-3 px-5 py-8 text-sm text-muted-foreground">
              <span className="inline-flex h-2 w-2 rounded-full bg-success animate-pulse-slow" />
              No open alerts — all systems nominal.
            </div>
          ) : (
            <ul className="divide-y divide-border">
              {openAlerts.slice(0, 5).map(alert => (
                <li key={alert.id} className="flex items-start gap-3 px-5 py-3.5">
                  <span className={cn('mt-1.5 h-2 w-2 shrink-0 rounded-full', alert.severity === 'critical' ? 'bg-danger' : alert.severity === 'warning' ? 'bg-warning' : 'bg-info')} />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{alert.message}</p>
                    <p className="mt-0.5 text-xs text-muted-foreground">{alert.service}</p>
                  </div>
                  <div className="flex shrink-0 flex-col items-end gap-1">
                    <StatusBadge status={alert.status as 'open' | 'resolved'} size="sm" />
                    <span className="text-xs text-muted-foreground">{formatRelativeTime(alert.time)}</span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      {/* Per-service detail drawer — Details / Restart / Logs / Metrics actions */}
      <ServiceDetailDrawer
        service={selected}
        open={drawerOpen}
        onClose={closeDrawer}
        onChanged={refresh}
        initialTab={drawerTab}
        autoConfirmRestart={autoRestart}
      />
    </div>
  );
}