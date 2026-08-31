import { Link } from 'react-router-dom';
import type { Service } from '../types';
import { useDashboardData } from '../context/DashboardDataContext';
import KpiCard from '../components/KpiCard';
import StatusBadge from '../components/StatusBadge';
import Button from '../components/Button';
import { cn, formatUptime, formatBytes } from '../lib/utils';

function ServiceCard({ service }: { service: Service }) {
  const statusConfig = {
    healthy: { bg: 'bg-success/10', border: 'border-success/30', dot: 'bg-success' },
    warning: { bg: 'bg-warning/10', border: 'border-warning/30', dot: 'bg-warning' },
    critical: { bg: 'bg-danger/10', border: 'border-danger/30', dot: 'bg-danger' },
    offline: { bg: 'bg-muted/40', border: 'border-muted', dot: 'bg-muted-foreground' },
  };
  const cfg = statusConfig[service.status];

  return (
    <Link to="/services" className={cn('group rounded-xl border bg-card p-5 transition-all hover:shadow-md hover:border-primary/40', cfg.bg, cfg.border)}>
      <div className="flex items-start justify-between">
        <div className="space-y-1.5">
          <div className="flex items-center gap-2">
            <span className="h-2 w-2 rounded-full" style={{ backgroundColor: `hsl(var(--${cfg.dot.replace('bg-', '')}) / 1)` }} />
            <h3 className="text-sm font-semibold text-foreground">{service.name}</h3>
          </div>
          <p className="text-xs text-muted-foreground line-clamp-2">{service.description}</p>
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span>v{service.version}</span>
            <span className="text-muted-foreground/50">·</span>
            <span>{service.environment}</span>
          </div>
        </div>
        <div className="flex gap-1">
          <StatusBadge status={service.status} size="sm" />
        </div>
      </div>
      <div className="mt-4 flex flex-wrap gap-4 border-t border-border pt-4 text-xs">
        <div className="space-y-1">
          <div className="flex items-center justify-between text-muted-foreground">
            <span>Health</span>
            <span className="font-medium text-foreground">{service.healthScore}%</span>
          </div>
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
            <div className="h-full rounded-full bg-primary" style={{ width: `${service.healthScore}%` }} />
          </div>
        </div>
        <div className="space-y-1">
          <div className="flex items-center justify-between text-muted-foreground">
            <span>CPU</span>
            <span className="font-medium text-foreground">{service.cpuUsage}%</span>
          </div>
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
            <div className="h-full rounded-full bg-info" style={{ width: `${service.cpuUsage}%` }} />
          </div>
        </div>
        <div className="space-y-1">
          <div className="flex items-center justify-between text-muted-foreground">
            <span>Memory</span>
            <span className="font-medium text-foreground">{service.memoryUsage}%</span>
          </div>
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
            <div className="h-full rounded-full bg-accent" style={{ width: `${service.memoryUsage}%` }} />
          </div>
        </div>
        <div className="space-y-1">
          <div className="flex items-center justify-between text-muted-foreground">
            <span>Traffic</span>
            <span className="font-medium text-foreground">{formatBytes(service.trafficBytesPerSec)}/s</span>
          </div>
        </div>
        <div className="space-y-1">
          <div className="flex items-center justify-between text-muted-foreground">
            <span>Last restart</span>
            <span className="font-medium text-foreground">{formatUptime(Math.floor((Date.now() - new Date(service.lastRestart).getTime()) / 1000))} ago</span>
          </div>
        </div>
      </div>
      <div className="mt-3 flex gap-2 text-xs">
        <Button variant="ghost" size="sm" className="text-muted-foreground hover:text-foreground">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-3.5 w-3.5"><circle cx="12" cy="12" r="10" /><path d="M12 8v4l2 2" /></svg>
          View
        </Button>
        <Button variant="ghost" size="sm" className="text-muted-foreground hover:text-foreground">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-3.5 w-3.5"><path d="M1 4v6h6" /><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" /></svg>
          Restart
        </Button>
        <Button variant="ghost" size="sm" className="text-muted-foreground hover:text-foreground">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-3.5 w-3.5"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path d="m9 13 2 2 4-4" /></svg>
          Logs
        </Button>
        <Button variant="ghost" size="sm" className="text-muted-foreground hover:text-foreground">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-3.5 w-3.5"><path d="M3 3v18h18" /><path d="m19 9-5 5-4-4-3 3" /></svg>
          Metrics
        </Button>
      </div>
    </Link>
  );
}

export default function Dashboard() {
  const { services, dashboardStats, alerts } = useDashboardData();

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Dashboard Overview</h1>
          <p className="mt-1 text-sm text-muted-foreground">Centralized operational visibility for all Capstone services.</p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="7 10 12 15 17 10" /><path d="M12 15V3" /></svg>
            Export report
          </Button>
          <Button variant="default" size="sm">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4"><path d="M3 3v18h18" /><path d="m19 9-5 5-4-4-3 3" /></svg>
            Refresh
          </Button>
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-8">
        <KpiCard
          title="Total Services"
          value={dashboardStats.totalServices}
          subtitle={`${services.length} tracked`}
          icon={<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-5 w-5"><rect x="2" y="3" width="20" height="14" rx="2" /><path d="M8 21h8" /><path d="M12 17v4" /></svg>}
        />
        <KpiCard
          title="Healthy Services"
          value={dashboardStats.healthyServices}
          subtitle="All systems nominal"
          icon={<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-5 w-5"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" /><polyline points="22 4 12 14.01 9 11.01" /></svg>}
          color="success"
        />
        <KpiCard
          title="Warning Services"
          value={dashboardStats.warningServices}
          subtitle="Attention required"
          icon={<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-5 w-5"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" /><path d="M12 9v4" /><path d="M12 17h.01" /></svg>}
          color="warning"
        />
        <KpiCard
          title="Critical Services"
          value={dashboardStats.criticalServices}
          subtitle="Immediate action needed"
          icon={<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-5 w-5"><circle cx="12" cy="12" r="10" /><path d="M12 8v4" /><path d="M12 16h.01" /></svg>}
          color="danger"
        />
        <KpiCard
          title="Active Ports"
          value={dashboardStats.activePorts}
          subtitle={`${services.length} services exposed`}
          icon={<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-5 w-5"><circle cx="12" cy="12" r="3" /><circle cx="19" cy="5" r="2" /><circle cx="5" cy="5" r="2" /><circle cx="5" cy="19" r="2" /><circle cx="19" cy="19" r="2" /></svg>}
        />
        <KpiCard
          title="Open Alerts"
          value={dashboardStats.openAlerts}
          subtitle="Requires attention"
          icon={<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-5 w-5"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" /><path d="M12 9v4" /><path d="M12 17h.01" /></svg>}
          color="warning"
        />
        <KpiCard
          title="Expiring Secrets"
          value={dashboardStats.expiringSecrets}
          subtitle="Within 7 days"
          icon={<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-5 w-5"><rect x="3" y="11" width="18" height="11" rx="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" /></svg>}
          color="info"
        />
        <KpiCard
          title="System Uptime %"
          value={`${dashboardStats.uptimePercent.toFixed(2)}%`}
          subtitle="Last 30 days"
          icon={<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-5 w-5"><circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" /></svg>}
          color="success"
        />
      </div>

      <div>
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">Services</h2>
          <Link to="/services" className="text-sm text-primary hover:underline">View all {services.length} services →</Link>
        </div>
        <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {services.map(service => (
            <div key={service.id} className="animate-in" style={{ animationDelay: `${Math.random() * 0.15}s` }}>
              <ServiceCard service={service} />
            </div>
          ))}
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <div>
          <h2 className="text-lg font-semibold">Recent Alerts</h2>
          <div className="mt-2 border rounded-xl bg-card shadow-sm overflow-hidden">
            <table className="w-full border-collapse">
              <thead>
                <tr className="border-b bg-muted/30">
                  <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-muted-foreground">Severity</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-muted-foreground">Service</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-muted-foreground">Message</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-muted-foreground">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {alerts.slice(0, 4).map(alert => (
                  <tr key={alert.id} className="hover:bg-muted/40 transition-colors">
                    <td className="px-4 py-3"><span className={alert.severity === 'critical' ? 'text-danger' : alert.severity === 'warning' ? 'text-warning' : 'text-info'}>●</span></td>
                    <td className="px-4 py-3 text-sm">{alert.service}</td>
                    <td className="px-4 py-3 text-sm text-muted-foreground">{alert.message}</td>
                    <td className="px-4 py-3"><StatusBadge status={alert.status as 'open' | 'resolved'} size="sm" /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
        <div>
          <h2 className="text-lg font-semibold">System Snapshot</h2>
          <div className="mt-2 grid gap-3 border rounded-xl bg-card shadow-sm p-5 text-sm">
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">CPU</span>
              <span className="font-medium">41%</span>
              <div className="ml-4 flex h-2 w-24 items-center gap-1 overflow-hidden rounded-full bg-muted">
                <div className="h-full w-[41%] rounded-full bg-primary" />
                <div className="h-full w-[59%] rounded-full bg-muted-foreground/30" />
              </div>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Memory</span>
              <span className="font-medium">64%</span>
              <div className="ml-4 flex h-2 w-24 items-center gap-1 overflow-hidden rounded-full bg-muted">
                <div className="h-full w-[64%] rounded-full bg-accent" />
                <div className="h-full w-[36%] rounded-full bg-muted-foreground/30" />
              </div>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Disk</span>
              <span className="font-medium">48%</span>
              <div className="ml-4 flex h-2 w-24 items-center gap-1 overflow-hidden rounded-full bg-muted">
                <div className="h-full w-[48%] rounded-full bg-warning" />
                <div className="h-full w-[52%] rounded-full bg-muted-foreground/30" />
              </div>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Network In</span>
              <span className="font-medium">142 MB/s</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Network Out</span>
              <span className="font-medium">92 MB/s</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Request Rate</span>
              <span className="font-medium">4,620 req/s</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Error Rate</span>
              <span className="font-medium text-danger">0.42%</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Active Sessions</span>
              <span className="font-medium">188</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
