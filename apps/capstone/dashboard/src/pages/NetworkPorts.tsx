import { useState, useMemo } from 'react';
import type { Port } from '../types';
import { useDashboardData } from '../context/DashboardDataContext';
import StatusBadge from '../components/StatusBadge';
import Button from '../components/Button';
import Drawer from '../components/Drawer';
import { cn, formatRelativeTime } from '../lib/utils';
import { exportPDFViaServer } from '../lib/export';
import Chart from '../components/Chart';

function riskClass(risk: string) {
  switch (risk) {
    case 'high':
    case 'critical':
      return 'text-danger';
    case 'medium':
      return 'text-warning';
    default:
      return 'text-muted-foreground';
  }
}

function protocolBadge(protocol: string) {
  const color = protocol === 'tls' ? 'bg-info/20 text-info' : protocol === 'udp' || protocol.includes('udp') ? 'bg-warning/20 text-warning' : 'bg-muted text-muted-foreground';
  return <span className={cn('rounded-md px-2 py-0.5 text-xs font-mono font-medium', color)}>{protocol}</span>;
}

function exportCSV(rows: Port[]) {
  const header = 'port,protocol,service,host,status,environment,owner,risk,lastSeen,utilization';
  const lines = rows.map(p => `${p.port},${p.protocol},${p.service},${p.host},${p.status},${p.environment},${p.owner},${p.risk},${p.lastSeen},${p.utilization}`);
  const csv = [header, ...lines].join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'capstone-ports.csv';
  a.click();
  URL.revokeObjectURL(url);
}

async function exportPDF(rows: Port[]) {
  await exportPDFViaServer({
    body: rows.map(p => ({
      port: p.port,
      protocol: p.protocol,
      service: p.service,
      host: p.host,
      status: p.status,
      environment: p.environment,
      owner: p.owner,
      risk: p.risk,
      lastSeen: p.lastSeen,
      utilization: p.utilization,
      tags: p.tags,
    })),
    filename: `capstone-ports-${new Date().toISOString().slice(0, 10)}.pdf`,
  });
}

export default function NetworkPorts() {
  const { ports } = useDashboardData();
  const [selected, setSelected] = useState<Port | null>(null);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [envFilter, setEnvFilter] = useState('all');
  const [riskFilter, setRiskFilter] = useState('all');

  const filtered = useMemo(() => {
    return ports.filter(p => {
      const matchesSearch = search === '' || String(p.port).includes(search) || p.service.toLowerCase().includes(search.toLowerCase()) || p.host.toLowerCase().includes(search.toLowerCase()) || p.owner.toLowerCase().includes(search.toLowerCase());
      const matchesStatus = statusFilter === 'all' || p.status === statusFilter;
      const matchesEnv = envFilter === 'all' || p.environment === envFilter;
      const matchesRisk = riskFilter === 'all' || p.risk === riskFilter;
      return matchesSearch && matchesStatus && matchesEnv && matchesRisk;
    });
  }, [search, statusFilter, envFilter, riskFilter]);

  const statusOptions = ['all', 'open', 'filtered', 'closed', 'unknown'];
  const envOptions = ['all', 'prod', 'stage', 'test', 'dev'];
  const riskOptions = ['all', 'low', 'medium', 'high', 'critical'];

  const utilizationChartData = useMemo(() => {
    const chartPorts = filtered.slice(0, 6);
    return chartPorts.map(p => ({ timestamp: p.lastSeen, value: p.utilization }));
  }, [filtered]);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Network Ports</h1>
          <p className="mt-1 text-sm text-muted-foreground">Inventory of open and monitored network endpoints across the cluster.</p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => exportCSV(filtered)}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="7 10 12 15 17 10" /><path d="M12 15V3" /></svg>
            Export CSV
          </Button>
          <Button variant="outline" size="sm" onClick={() => exportPDF(filtered)}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path d="m9 13 2 2 4-4" /><path d="M14 2v4h4" /></svg>
            Export PDF
          </Button>
        </div>
      </div>

      <div className="grid gap-2 sm:grid-cols-4">
        <div className="relative">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground"><circle cx="11" cy="11" r="8" /><path d="m21 21-4.35-4.35" /></svg>
          <input
            type="search"
            placeholder="Search ports, hosts, owners…"
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="h-9 w-full min-w-[200px] rounded-md border bg-background pl-9 pr-3 py-2 text-sm placeholder:text-muted-foreground focus:border-primary focus:outline-none"
            aria-label="Search ports"
          />
        </div>
        <div className="flex rounded-md border bg-background p-1" role="group" aria-label="Status filter">
          {statusOptions.map(opt => (
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
          {envOptions.map(opt => (
            <button
              key={opt}
              onClick={() => setEnvFilter(opt)}
              className={cn('rounded-md px-3 py-1.5 text-xs font-medium transition-colors', envFilter === opt ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground')}
            >
              {opt === 'all' ? 'All' : opt === 'prod' ? 'Prod' : opt === 'stage' ? 'Stage' : opt === 'test' ? 'Test' : opt === 'dev' ? 'Dev' : opt}
            </button>
          ))}
        </div>
        <div className="flex rounded-md border bg-background p-1" role="group" aria-label="Risk filter">
          {riskOptions.map(opt => (
            <button
              key={opt}
              onClick={() => setRiskFilter(opt)}
              className={cn('rounded-md px-3 py-1.5 text-xs font-medium transition-colors', riskFilter === opt ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground')}
            >
              {opt === 'all' ? 'Risk' : opt.charAt(0).toUpperCase() + opt.slice(1)}
            </button>
          ))}
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-5">
        <div className="lg:col-span-3 border rounded-2xl bg-card shadow-sm overflow-hidden">
          <table className="w-full border-collapse">
            <thead>
              <tr className="border-b bg-muted/30">
                <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-muted-foreground">Port</th>
                <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-muted-foreground">Protocol</th>
                <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-muted-foreground">Service</th>
                <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-muted-foreground">Host</th>
                <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-muted-foreground">Status</th>
                <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-muted-foreground">Environment</th>
                <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-muted-foreground">Owner</th>
                <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-muted-foreground">Security Risk</th>
                <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-muted-foreground">Last Seen</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {filtered.map((p, idx) => (
                <tr key={idx} className="cursor-pointer hover:bg-muted/40 transition-colors" onClick={() => setSelected(p)}>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <span className="font-mono font-semibold">{p.port}</span>
                      {p.utilization > 70 && <span className="h-2 w-2 rounded-full bg-danger" title="High utilization" />}
                    </div>
                  </td>
                  <td className="px-4 py-3">{protocolBadge(p.protocol)}</td>
                  <td className="px-4 py-3 font-medium">{p.service}</td>
                  <td className="px-4 py-3 font-mono text-sm text-muted-foreground">{p.host}</td>
                  <td className="px-4 py-3"><StatusBadge status={p.status as 'open' | 'filtered' | 'closed' | 'unknown'} size="sm" /></td>
                  <td className="px-4 py-3 text-sm">
                    <span className={cn('rounded-full px-2 py-0.5 text-xs font-medium', p.environment === 'prod' ? 'bg-success/20 text-success' : p.environment === 'stage' ? 'bg-info/20 text-info' : p.environment === 'test' ? 'bg-warning/20 text-warning' : 'bg-muted-foreground/20 text-muted-foreground')}>
                      {p.environment}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-sm text-muted-foreground">{p.owner}</td>
                  <td className="px-4 py-3"><span className={cn('text-xs font-medium uppercase', riskClass(p.risk))}>{p.risk}</span></td>
                  <td className="px-4 py-3 text-sm text-muted-foreground">{formatRelativeTime(p.lastSeen)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {filtered.length === 0 && (
            <div className="flex flex-col items-center justify-center py-12 border-t text-center">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="mx-auto h-8 w-8 text-muted-foreground"><circle cx="12" cy="12" r="10" /><path d="M16 16s-1.5-2-4-2-4 2-4 2" /><line x1="9" y1="9" x2="9.01" y2="9" /><line x1="15" y1="9" x2="15.01" y2="9" /></svg>
              <p className="mt-2 text-sm font-medium">No ports match your filters.</p>
              <p className="text-xs text-muted-foreground">Try clearing the search or filters.</p>
            </div>
          )}
        </div>

        <div className="lg:col-span-2 space-y-4">
          <div>
            <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">Port Utilization</h2>
            <div className="mt-2 border rounded-2xl bg-card shadow-sm p-4">
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">Avg utilization</span>
                <span className="font-semibold">{filtered.length ? Math.round(filtered.reduce((s, p) => s + p.utilization, 0) / filtered.length) : 0}%</span>
              </div>
              <div className="mt-3 h-10 w-full overflow-hidden rounded-full bg-muted">
                <div className="h-full w-full rounded-full bg-primary/80" style={{ width: `${Math.min(100, filtered.reduce((s, p) => s + p.utilization, 0) / filtered.length)}%` }} />
              </div>
              <Chart data={utilizationChartData} color="hsl(var(--primary))" height={120} formatY={v => `${v}%`} />
            </div>
          </div>
          <div>
            <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">Top Utilization</h2>
            <div className="mt-2 divide-y">
              {filtered.sort((a, b) => b.utilization - a.utilization).slice(0, 5).map(p => (
                <div key={p.port} className="flex items-center justify-between py-2">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-sm font-medium">{p.port}</span>
                    <span className="text-xs text-muted-foreground">{p.service}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <div className="h-1.5 w-20 overflow-hidden rounded-full bg-muted">
                      <div className="h-full rounded-full bg-primary" style={{ width: `${p.utilization}%` }} />
                    </div>
                    <span className="text-xs font-mono text-muted-foreground">{p.utilization}%</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
          <div>
            <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">Quick Filter Stats</h2>
            <div className="mt-2 grid grid-cols-2 gap-3 border rounded-2xl bg-card shadow-sm p-4 text-sm">
              <div className="space-y-1">
                <span className="text-muted-foreground">Total ports</span>
                <span className="font-semibold">{ports.length}</span>
              </div>
              <div className="space-y-1">
                <span className="text-muted-foreground">Open</span>
                <span className="font-semibold text-success">{ports.filter(p => p.status === 'open').length}</span>
              </div>
              <div className="space-y-1">
                <span className="text-muted-foreground">Filtered</span>
                <span className="font-semibold text-warning">{ports.filter(p => p.status === 'filtered').length}</span>
              </div>
              <div className="space-y-1">
                <span className="text-muted-foreground">Closed</span>
                <span className="font-semibold text-danger">{ports.filter(p => p.status === 'closed').length}</span>
              </div>
              <div className="space-y-1 col-span-2">
                <span className="text-muted-foreground">By risk</span>
                <div className="flex flex-wrap gap-2 text-xs">
                  {['critical', 'high', 'medium', 'low'].map(risk => (
                    <span key={risk} className={cn('rounded-full px-2 py-0.5', risk === 'critical' || risk === 'high' ? 'bg-danger/10 text-danger' : risk === 'medium' ? 'bg-warning/10 text-warning' : 'bg-muted text-muted-foreground')}>
                      {risk} {ports.filter(p => p.risk === risk).length}
                    </span>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <Drawer open={!!selected} onClose={() => setSelected(null)} title={selected ? `${selected.service} · :${selected.port}` : 'Port'} size="md">
        {selected && (
          <div className="space-y-5">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="font-mono text-2xl font-bold tracking-tight">:{selected.port}</p>
                <p className="mt-1 text-sm text-muted-foreground">{selected.host}</p>
              </div>
              <StatusBadge status={selected.status as 'open' | 'filtered' | 'closed' | 'unknown'} size="md" />
            </div>

            <div className="grid gap-3 rounded-2xl border bg-card p-5 text-sm">
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Protocol</span>
                {protocolBadge(selected.protocol)}
              </div>
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Service</span>
                <span className="font-medium">{selected.service}</span>
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
                <span className="text-muted-foreground">Security Risk</span>
                <span className={cn('text-xs font-medium uppercase', riskClass(selected.risk))}>{selected.risk}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Last Seen</span>
                <span className="font-medium">{formatRelativeTime(selected.lastSeen)}</span>
              </div>
              <div>
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">Utilization</span>
                  <span className="font-medium">{selected.utilization}%</span>
                </div>
                <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-muted">
                  <div className={cn('h-full rounded-full', selected.utilization > 70 ? 'bg-danger' : selected.utilization > 40 ? 'bg-warning' : 'bg-success')} style={{ width: `${selected.utilization}%` }} />
                </div>
              </div>
              {selected.tags.length > 0 && (
                <div className="flex items-center justify-between gap-3">
                  <span className="text-muted-foreground">Tags</span>
                  <span className="flex max-w-[60%] flex-wrap justify-end gap-1">
                    {selected.tags.map(t => (
                      <span key={t} className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">{t}</span>
                    ))}
                  </span>
                </div>
              )}
            </div>

            <div className="flex flex-wrap gap-2 border-t border-border pt-4">
              {selected.status === 'open' && (selected.protocol === 'tcp' || selected.protocol === 'tls' || selected.protocol === 'tcp6') && (
                <a href={`http://${selected.host}:${selected.port}`} target="_blank" rel="noreferrer">
                  <Button variant="default" size="sm">Open endpoint</Button>
                </a>
              )}
              <Button variant="outline" size="sm" onClick={() => { navigator.clipboard.writeText(`${selected.host}:${selected.port}`).catch(() => {}); }}>
                Copy host:port
              </Button>
            </div>
          </div>
        )}
      </Drawer>
    </div>
  );
}
