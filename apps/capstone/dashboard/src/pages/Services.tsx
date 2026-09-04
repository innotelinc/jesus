import { useCallback, useState } from 'react';
import type { Service } from '../types';
import { useDashboardData } from '../context/DashboardDataContext';
import StatusBadge from '../components/StatusBadge';
import ServiceDetailDrawer, { type ServiceTab } from '../components/ServiceDetailDrawer';
import Button from '../components/Button';
import { cn, formatBytes, formatRelativeTime } from '../lib/utils';
import { exportJSON } from '../lib/export';

export default function Services() {
  const { services, refresh } = useDashboardData();
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [envFilter, setEnvFilter] = useState<string>('all');
  const [selected, setSelected] = useState<Service | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [drawerTab, setDrawerTab] = useState<ServiceTab>('overview');

  const filtered = services.filter(s => {
    const matchesSearch = search === '' || s.name.toLowerCase().includes(search.toLowerCase()) || s.description.toLowerCase().includes(search.toLowerCase());
    const matchesStatus = statusFilter === 'all' || s.status === statusFilter;
    const matchesEnv = envFilter === 'all' || s.environment === envFilter;
    return matchesSearch && matchesStatus && matchesEnv;
  });

  const openService = useCallback((service: Service, tab: ServiceTab) => {
    setSelected(service);
    setDrawerTab(tab);
    setDrawerOpen(true);
  }, []);

  const closeDrawer = useCallback(() => {
    setDrawerOpen(false);
    setSelected(null);
  }, []);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Services</h1>
          <p className="mt-1 text-sm text-muted-foreground">Manage and monitor all Capstone services.</p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => exportJSON(services, { filename: `capstone-services-${new Date().toISOString().slice(0, 10)}.json` })}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="7 10 12 15 17 10" /><path d="M12 15V3" /></svg>
            Export
          </Button>
          <Button variant="default" size="sm" onClick={() => void refresh()}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4"><path d="M3 3v18h18" /><path d="m19 9-5 5-4-4-3 3" /></svg>
            Refresh
          </Button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <input
          type="search"
          placeholder="Filter by name or description…"
          value={search}
          onChange={e => setSearch(e.target.value)}
          className="h-9 w-full min-w-[240px] rounded-lg border bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus:border-primary focus:outline-none"
          aria-label="Filter services"
        />
        <div className="flex rounded-lg border bg-background px-1 py-1" role="group" aria-label="Status filter">
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
        <div className="flex rounded-lg border bg-background px-1 py-1" role="group" aria-label="Environment filter">
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

      <div className="mt-4 overflow-hidden rounded-2xl border bg-card shadow-sm">
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
          <tbody className="divide-y divide-border">
            {filtered.map(service => (
              <tr key={service.id} className="cursor-pointer transition-colors hover:bg-muted/40" onClick={() => openService(service, 'overview')}>
                <td className="px-4 py-3">
                  <div className="flex items-center gap-2">
                    <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-primary/10 text-xs font-semibold text-primary">
                      {service.name.charAt(0)}
                    </div>
                    <span className="font-medium">{service.name}</span>
                  </div>
                </td>
                <td className="max-w-[220px] truncate px-4 py-3 text-sm text-muted-foreground">{service.description}</td>
                <td className="px-4 py-3"><StatusBadge status={service.status} size="sm" /></td>
                <td className="px-4 py-3 font-mono text-sm text-muted-foreground">v{service.version}</td>
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
          <div className="flex flex-col items-center justify-center border-t py-12 text-center">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="mx-auto h-8 w-8 text-muted-foreground"><circle cx="12" cy="12" r="10" /><path d="M16 16s-1.5-2-4-2-4 2-4 2" /><line x1="9" y1="9" x2="9.01" y2="9" /><line x1="15" y1="9" x2="15.01" y2="9" /></svg>
            <p className="mt-2 text-sm font-medium">No services match your filters.</p>
            <p className="text-xs text-muted-foreground">Try clearing the search or filters.</p>
          </div>
        )}
      </div>

      <ServiceDetailDrawer
        service={selected}
        open={drawerOpen}
        onClose={closeDrawer}
        onChanged={refresh}
        initialTab={drawerTab}
      />
    </div>
  );
}