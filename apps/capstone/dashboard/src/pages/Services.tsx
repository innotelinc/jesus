import { useState } from 'react';
import type { Service } from '../types';
import { useDashboardData } from '../context/DashboardDataContext';
import StatusBadge from '../components/StatusBadge';
import Button from '../components/Button';
import Drawer from '../components/Drawer';
import { cn, formatUptime, formatBytes, formatRelativeTime } from '../lib/utils';
function ServiceDetail({ service }: { service: Service }) {
  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between">
        <div>
          <h2 className="text-lg font-semibold">{service.name}</h2>
          <p className="text-sm text-muted-foreground">{service.description}</p>
        </div>
        <StatusBadge status={service.status} size="md" />
      </div>

      <div className="grid gap-3 border rounded-xl bg-card p-5 text-sm">
        <div className="flex items-center justify-between">
          <span className="text-muted-foreground">Version</span>
          <span className="font-medium">{service.version}</span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-muted-foreground">Environment</span>
          <span className="font-medium">{service.environment}</span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-muted-foreground">Owner</span>
          <span className="font-medium">{service.owner}</span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-muted-foreground">Health Score</span>
          <span className="font-medium">{service.healthScore}%</span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-muted-foreground">CPU Usage</span>
          <span className="font-medium">{service.cpuUsage}%</span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-muted-foreground">Memory Usage</span>
          <span className="font-medium">{service.memoryUsage}%</span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-muted-foreground">Memory</span>
          <span className="font-medium">{formatBytes(service.memoryBytes)}</span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-muted-foreground">Network Traffic</span>
          <span className="font-medium">{formatBytes(service.trafficBytesPerSec)}/s</span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-muted-foreground">Last Restart</span>
          <span className="font-medium">{formatRelativeTime(service.lastRestart)}</span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-muted-foreground">Uptime</span>
          <span className="font-medium">{formatUptime(service.uptimeSeconds)}</span>
        </div>
      </div>

      <div className="space-y-3">
        <h3 className="text-sm font-semibold">Health</h3>
        <div className="grid gap-3 border rounded-xl bg-card p-5 text-sm">
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">Latency</span>
            <span className="font-medium">{service.health.latencyMs}ms</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">Error Rate</span>
            <span className={service.health.errorRate > 1 ? 'text-danger' : 'font-medium'}>{service.health.errorRate}%</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">Availability</span>
            <span className="font-medium">{service.health.availability}%</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">Last Check</span>
            <span className="font-medium">{formatRelativeTime(service.health.checkedAt)}</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">Dependencies</span>
            <span className="flex flex-wrap gap-1">
              {service.health.dependencies.length ? service.health.dependencies.map(d => (
                <span key={d} className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">{d}</span>
              )) : <span className="text-muted-foreground">None</span>}
            </span>
          </div>
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        <Button variant="default" size="sm">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4"><circle cx="12" cy="12" r="10" /><path d="M12 8v4l2 2" /></svg>
          View details
        </Button>
        <Button variant="secondary" size="sm">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4"><path d="M1 4v6h6" /><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" /></svg>
          Restart
        </Button>
        <Button variant="outline" size="sm">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path d="m9 13 2 2 4-4" /></svg>
          Logs
        </Button>
        <Button variant="outline" size="sm">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4"><path d="M3 3v18h18" /><path d="m19 9-5 5-4-4-3 3" /></svg>
          Metrics
        </Button>
      </div>
    </div>
  );
}

export default function Services() {
  const { services } = useDashboardData();
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [envFilter, setEnvFilter] = useState<string>('all');
  const [selected, setSelected] = useState<Service | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);

  const filtered = services.filter(s => {
    const matchesSearch = search === '' || s.name.toLowerCase().includes(search.toLowerCase()) || s.description.toLowerCase().includes(search.toLowerCase());
    const matchesStatus = statusFilter === 'all' || s.status === statusFilter;
    const matchesEnv = envFilter === 'all' || s.environment === envFilter;
    return matchesSearch && matchesStatus && matchesEnv;
  });

  const openDrawer = (service: Service) => {
    setSelected(service);
    setDrawerOpen(true);
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Services</h1>
          <p className="mt-1 text-sm text-muted-foreground">Manage and monitor all Capstone services.</p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="7 10 12 15 17 10" /><path d="M12 15V3" /></svg>
            Export
          </Button>
          <Button variant="default" size="sm">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4"><path d="M12 5v14M5 12h14" /></svg>
            Add service
          </Button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <input
          type="search"
          placeholder="Filter by name or description…"
          value={search}
          onChange={e => setSearch(e.target.value)}
          className="h-9 w-full min-w-[240px] rounded-md border bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus:border-primary focus:outline-none"
          aria-label="Filter services"
        />
        <div className="flex rounded-md border bg-background px-1 py-1" role="group" aria-label="Status filter">
          <button
            onClick={() => setStatusFilter('all')}
            className={cn('rounded-md px-3 py-1.5 text-xs font-medium transition-colors', statusFilter === 'all' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground')}
          >
            All
          </button>
          <button
            onClick={() => setStatusFilter('healthy')}
            className={cn('rounded-md px-3 py-1.5 text-xs font-medium transition-colors', statusFilter === 'healthy' ? 'bg-success/20 text-success' : 'text-muted-foreground hover:text-foreground')}
          >
            Healthy
          </button>
          <button
            onClick={() => setStatusFilter('warning')}
            className={cn('rounded-md px-3 py-1.5 text-xs font-medium transition-colors', statusFilter === 'warning' ? 'bg-warning/20 text-warning' : 'text-muted-foreground hover:text-foreground')}
          >
            Warning
          </button>
          <button
            onClick={() => setStatusFilter('critical')}
            className={cn('rounded-md px-3 py-1.5 text-xs font-medium transition-colors', statusFilter === 'critical' ? 'bg-danger/20 text-danger' : 'text-muted-foreground hover:text-foreground')}
          >
            Critical
          </button>
          <button
            onClick={() => setStatusFilter('offline')}
            className={cn('rounded-md px-3 py-1.5 text-xs font-medium transition-colors', statusFilter === 'offline' ? 'bg-muted text-muted-foreground' : 'text-muted-foreground hover:text-foreground')}
          >
            Offline
          </button>
        </div>
        <div className="flex rounded-md border bg-background px-1 py-1" role="group" aria-label="Environment filter">
          <button
            onClick={() => setEnvFilter('all')}
            className={cn('rounded-md px-3 py-1.5 text-xs font-medium transition-colors', envFilter === 'all' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground')}
          >
            All envs
          </button>
          <button
            onClick={() => setEnvFilter('prod')}
            className={cn('rounded-md px-3 py-1.5 text-xs font-medium transition-colors', envFilter === 'prod' ? 'bg-success/20 text-success' : 'text-muted-foreground hover:text-foreground')}
          >
            Prod
          </button>
          <button
            onClick={() => setEnvFilter('stage')}
            className={cn('rounded-md px-3 py-1.5 text-xs font-medium transition-colors', envFilter === 'stage' ? 'bg-info/20 text-info' : 'text-muted-foreground hover:text-foreground')}
          >
            Stage
          </button>
          <button
            onClick={() => setEnvFilter('test')}
            className={cn('rounded-md px-3 py-1.5 text-xs font-medium transition-colors', envFilter === 'test' ? 'bg-warning/20 text-warning' : 'text-muted-foreground hover:text-foreground')}
          >
            Test
          </button>
          <button
            onClick={() => setEnvFilter('dev')}
            className={cn('rounded-md px-3 py-1.5 text-xs font-medium transition-colors', envFilter === 'dev' ? 'bg-muted-foreground text-foreground' : 'text-muted-foreground hover:text-foreground')}
          >
            Dev
          </button>
        </div>
      </div>

      <div className="mt-4 border rounded-xl bg-card shadow-sm overflow-hidden">
        <table className="w-full border-collapse">
          <thead>
            <tr className="border-b bg-muted/30">
              <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-muted-foreground">Service</th>
              <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-muted-foreground">Description</th>
              <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-muted-foreground">Status</th>
              <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-muted-foreground">Version</th>
              <th className="px-4 py-3 text-right text-xs font-semibold uppercase tracking-wider text-muted-foreground">Health</th>
              <th className="px-4 py-3 text-right text-xs font-semibold uppercase tracking-wider text-muted-foreground">CPU</th>
              <th className="px-4 py-3 text-right text-xs font-semibold uppercase tracking-wider text-muted-foreground">Memory</th>
              <th className="px-4 py-3 text-right text-xs font-semibold uppercase tracking-wider text-muted-foreground">Traffic</th>
              <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-muted-foreground">Last restart</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {filtered.map(service => (
              <tr key={service.id} className="hover:bg-muted/40 transition-colors cursor-pointer" onClick={() => openDrawer(service)}>
                <td className="px-4 py-3">
                  <div className="flex items-center gap-2">
                    <div className="flex h-7 w-7 items-center justify-center rounded bg-primary/10 text-primary text-xs font-semibold">
                      {service.name.charAt(0)}
                    </div>
                    <span className="font-medium">{service.name}</span>
                  </div>
                </td>
                <td className="px-4 py-3 text-sm text-muted-foreground max-w-[220px] truncate">{service.description}</td>
                <td className="px-4 py-3"><StatusBadge status={service.status} size="sm" /></td>
                <td className="px-4 py-3 text-sm text-muted-foreground">v{service.version}</td>
                <td className="px-4 py-3 text-right">
                  <div className="flex items-center justify-end gap-2">
                    <span className="font-medium">{service.healthScore}%</span>
                    <div className="h-1.5 w-16 overflow-hidden rounded-full bg-muted">
                      <div className="h-full rounded-full bg-primary" style={{ width: `${service.healthScore}%` }} />
                    </div>
                  </div>
                </td>
                <td className="px-4 py-3 text-right">
                  <div className="flex items-center justify-end gap-2">
                    <span className="font-medium">{service.cpuUsage}%</span>
                    <div className="h-1.5 w-16 overflow-hidden rounded-full bg-muted">
                      <div className="h-full rounded-full bg-info" style={{ width: `${service.cpuUsage}%` }} />
                    </div>
                  </div>
                </td>
                <td className="px-4 py-3 text-right">
                  <div className="flex items-center justify-end gap-2">
                    <span className="font-medium">{service.memoryUsage}%</span>
                    <div className="h-1.5 w-16 overflow-hidden rounded-full bg-muted">
                      <div className="h-full rounded-full bg-accent" style={{ width: `${service.memoryUsage}%` }} />
                    </div>
                  </div>
                </td>
                <td className="px-4 py-3 text-right text-sm text-muted-foreground">{formatBytes(service.trafficBytesPerSec)}/s</td>
                <td className="px-4 py-3 text-sm text-muted-foreground">{formatRelativeTime(service.lastRestart)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {filtered.length === 0 && (
          <div className="flex flex-col items-center justify-center py-12 border-t text-center">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="mx-auto h-8 w-8 text-muted-foreground"><circle cx="12" cy="12" r="10" /><path d="M16 16s-1.5-2-4-2-4 2-4 2" /><line x1="9" y1="9" x2="9.01" y2="9" /><line x1="15" y1="9" x2="15.01" y2="9" /></svg>
            <p className="mt-2 text-sm font-medium">No services match your filters.</p>
            <p className="text-xs text-muted-foreground">Try clearing the search or filters.</p>
          </div>
        )}
      </div>

      <Drawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        title={selected ? selected.name : 'Service'}
        size="lg"
      >
        {selected && <ServiceDetail service={selected} />}
      </Drawer>
    </div>
  );
}
