import { useState, useMemo } from 'react';
import type { Alert } from '../types';
import { useDashboardData } from '../context/DashboardDataContext';
import StatusBadge from '../components/StatusBadge';
import Button from '../components/Button';
import Modal from '../components/Modal';
import { cn, formatRelativeTime } from '../lib/utils';

function severityColor(severity: string) {
  switch (severity) {
    case 'critical':
      return 'bg-danger/10 border-danger/30 text-danger';
    case 'warning':
      return 'bg-warning/10 border-warning/30 text-warning';
    default:
      return 'bg-info/10 border-info/30 text-info';
  }
}

export default function Alerts() {
  const { alerts } = useDashboardData();
  const [severityFilter, setSeverityFilter] = useState<string>('all');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [escalateModalOpen, setEscalateModalOpen] = useState(false);
  const [selectedAlert, setSelectedAlert] = useState<Alert | null>(null);

  const filtered = useMemo(() => {
    return alerts.filter(a => {
      const matchesSeverity = severityFilter === 'all' || a.severity === severityFilter;
      const matchesStatus = statusFilter === 'all' || a.status === statusFilter;
      return matchesSeverity && matchesStatus;
    });
  }, [severityFilter, statusFilter]);

  const escalate = (alert: Alert) => {
    setSelectedAlert(alert);
    setEscalateModalOpen(true);
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Alerts</h1>
          <p className="mt-1 text-sm text-muted-foreground">Operational alerts with severity, assignment, and resolution workflow.</p>
        </div>
        <div className="flex items-center gap-3">
          <div className="flex rounded-lg border bg-background p-1" role="group" aria-label="Severity filter">
            {['all', 'critical', 'warning', 'info'].map(s => (
              <button
                key={s}
                onClick={() => setSeverityFilter(s)}
                className={cn(
                  'rounded-md px-3 py-1.5 text-xs font-medium transition-colors',
                  severityFilter === s ? (s === 'critical' ? 'bg-danger/20 text-danger' : s === 'warning' ? 'bg-warning/20 text-warning' : s === 'info' ? 'bg-info/20 text-info' : 'bg-primary text-primary-foreground') : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {s === 'all' ? 'All' : s.charAt(0).toUpperCase() + s.slice(1)}
              </button>
            ))}
          </div>
          <div className="flex rounded-lg border bg-background p-1" role="group" aria-label="Status filter">
            {['all', 'open', 'acknowledged', 'resolved', 'escalated'].map(s => (
              <button
                key={s}
                onClick={() => setStatusFilter(s)}
                className={cn(
                  'rounded-md px-3 py-1.5 text-xs font-medium transition-colors',
                  statusFilter === s ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {s === 'all' ? 'All' : s.charAt(0).toUpperCase() + s.slice(1)}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-4">
        <div className="rounded-2xl border bg-card p-4 shadow-sm text-sm">
          <div className="text-xs text-muted-foreground uppercase tracking-wide">Critical</div>
          <div className="mt-1 text-2xl font-semibold text-danger">{filtered.filter(a => a.severity === 'critical').length}</div>
        </div>
        <div className="rounded-2xl border bg-card p-4 shadow-sm text-sm">
          <div className="text-xs text-muted-foreground uppercase tracking-wide">Warning</div>
          <div className="mt-1 text-2xl font-semibold text-warning">{filtered.filter(a => a.severity === 'warning').length}</div>
        </div>
        <div className="rounded-2xl border bg-card p-4 shadow-sm text-sm">
          <div className="text-xs text-muted-foreground uppercase tracking-wide">Info</div>
          <div className="mt-1 text-2xl font-semibold text-info">{filtered.filter(a => a.severity === 'info').length}</div>
        </div>
        <div className="rounded-2xl border bg-card p-4 shadow-sm text-sm">
          <div className="text-xs text-muted-foreground uppercase tracking-wide">Open</div>
          <div className="mt-1 text-2xl font-semibold">{filtered.filter(a => a.status === 'open').length}</div>
        </div>
      </div>

      <div className="border rounded-2xl bg-card shadow-sm overflow-hidden">
        <table className="w-full border-collapse">
          <thead>
            <tr className="border-b bg-muted/30">
              <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-muted-foreground">Time</th>
              <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-muted-foreground">Service</th>
              <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-muted-foreground">Severity</th>
              <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-muted-foreground">Message</th>
              <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-muted-foreground">Status</th>
              <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-muted-foreground">Assigned To</th>
              <th className="px-4 py-3 w-[160px]">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {filtered.map(alert => (
              <tr key={alert.id} className="hover:bg-muted/40 transition-colors">
                <td className="px-4 py-3 text-sm text-muted-foreground">{formatRelativeTime(alert.time)}</td>
                <td className="px-4 py-3">
                  <div className="flex items-center gap-2">
                    <div className={cn('h-2 w-2 rounded-full', severityColor(alert.severity).split(' ')[0].replace('bg-', ''))} />
                    <span className="font-medium">{alert.service}</span>
                  </div>
                </td>
                <td className="px-4 py-3">
                  <span className={cn('inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium border', severityColor(alert.severity))}>
                    <span className={cn('h-2 w-2 rounded-full', severityColor(alert.severity).split(' ')[0].replace('bg-', ''))} />
                    {alert.severity}
                  </span>
                </td>
                <td className="px-4 py-3 text-sm text-muted-foreground max-w-[280px] truncate">{alert.message}</td>
                <td className="px-4 py-3"><StatusBadge status={alert.status as 'open' | 'acknowledged' | 'resolved' | 'escalated'} size="sm" /></td>
                <td className="px-4 py-3 text-sm text-muted-foreground">{alert.assignedTo || '—'}</td>
                <td className="px-4 py-3">
                  <div className="flex gap-1">
                    {alert.status === 'open' && (
                      <Button variant="outline" size="sm" className="h-7 text-xs">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-3.5 w-3.5"><path d="M9 12l2 2 4-4" /></svg>
                        Acknowledge
                      </Button>
                    )}
                    {alert.status === 'open' && (
                      <Button variant="secondary" size="sm" className="h-7 text-xs">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-3.5 w-3.5"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" /><polyline points="22 4 12 14.01 9 11.01" /></svg>
                        Resolve
                      </Button>
                    )}
                    <Button variant="ghost" size="sm" className="h-7 text-xs text-muted-foreground hover:text-foreground" onClick={() => escalate(alert)}>
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-3.5 w-3.5"><path d="M18 15a3 3 0 0 0 3-3 3 3 0 0 0-3-3M15 9a3 3 0 0 0-3 3 3 3 0 0 0 3 3" /><path d="M3 9h6m2 5l3-3 3 3" /></svg>
                      Escalate
                    </Button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {filtered.length === 0 && (
          <div className="flex flex-col items-center justify-center py-12 border-t text-center">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="mx-auto h-8 w-8 text-muted-foreground"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" /><path d="M12 9v4" /><path d="M12 17h.01" /></svg>
            <p className="mt-2 text-sm font-medium">No alerts match your filters.</p>
            <p className="text-xs text-muted-foreground">All clear — or try adjusting the filters.</p>
          </div>
        )}
      </div>

      <Modal
        open={escalateModalOpen}
        onClose={() => setEscalateModalOpen(false)}
        title="Escalate alert"
        size="sm"
      >
        {selectedAlert && (
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              Escalating <span className="font-medium text-foreground">{selectedAlert.service}</span> —{' '}
              <span className="text-foreground">{selectedAlert.message}</span>
            </p>
            <div className="space-y-2">
              <label className="text-sm font-medium">Escalation reason</label>
              <textarea
                rows={3}
                className="w-full rounded-md border bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus:border-primary focus:outline-none resize-none"
                placeholder="Enter escalation reason…"
              />
            </div>
            <div className="grid gap-2">
              <label className="text-sm font-medium">Assign to</label>
              <select className="h-9 w-full rounded-md border bg-background px-3 py-2 text-sm focus:border-primary focus:outline-none" defaultValue="Automation">
                <option>Automation</option>
                <option>DevOps</option>
                <option>SRE</option>
                <option>Platform</option>
                <option>Voice</option>
                <option>Data</option>
              </select>
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <Button variant="outline" size="sm" onClick={() => setEscalateModalOpen(false)}>Cancel</Button>
              <Button variant="destructive" size="sm">Escalate</Button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
