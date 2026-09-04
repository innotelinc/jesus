import { useCallback, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import type { Service } from '../types';
import Drawer from './Drawer';
import StatusBadge from './StatusBadge';
import Button from './Button';
import { api, type ServiceLogs } from '../lib/api';
import { cn, formatUptime, formatBytes, formatRelativeTime } from '../lib/utils';

export type ServiceTab = 'overview' | 'logs';

interface ServiceDetailDrawerProps {
  service: Service | null;
  open: boolean;
  onClose: () => void;
  /** Called after a restart succeeds so the caller can refresh its data. */
  onChanged?: () => void;
  initialTab?: ServiceTab;
  /** When true (e.g. Restart clicked from a card), arm the restart confirm step. */
  autoConfirmRestart?: boolean;
}

function InfoRow({ label, children, mono = false }: { label: string; children: ReactNode; mono?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <span className="text-muted-foreground">{label}</span>
      <span className={cn('font-medium text-foreground', mono && 'font-mono text-xs')}>{children}</span>
    </div>
  );
}

export default function ServiceDetailDrawer({ service, open, onClose, onChanged, initialTab = 'overview', autoConfirmRestart = false }: ServiceDetailDrawerProps) {
  const navigate = useNavigate();
  const [tab, setTab] = useState<ServiceTab>(initialTab);
  const [logs, setLogs] = useState<ServiceLogs | null>(null);
  const [logsLoading, setLogsLoading] = useState(false);
  const [logsError, setLogsError] = useState<string | null>(null);
  const [confirmingRestart, setConfirmingRestart] = useState(false);
  const [busy, setBusy] = useState(false);
  const [actionMsg, setActionMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  // Reset transient state whenever a different service opens.
  useEffect(() => {
    if (open && service) {
      setTab(initialTab);
      setLogs(null);
      setLogsError(null);
      setConfirmingRestart(false);
      setActionMsg(null);
      if (autoConfirmRestart) {
        setConfirmingRestart(true);
      }
    }
  }, [open, service?.id, initialTab, autoConfirmRestart]);

  const loadLogs = useCallback(async () => {
    if (!service) return;
    setLogsLoading(true);
    setLogsError(null);
    try {
      const result = await api.serviceLogs(service.id);
      setLogs(result);
    } catch (error) {
      setLogsError(error instanceof Error ? error.message : 'Failed to load logs');
    } finally {
      setLogsLoading(false);
    }
  }, [service]);

  useEffect(() => {
    if (open && service && tab === 'logs') {
      void loadLogs();
    }
  }, [open, service, tab, loadLogs]);

  const doRestart = async () => {
    if (!service || busy) return;
    setBusy(true);
    setActionMsg(null);
    try {
      await api.restartService(service.id);
      setActionMsg({ kind: 'ok', text: `${service.name} restarted — reloading state…` });
      setConfirmingRestart(false);
      onChanged?.();
      // Give docker a moment, then surface fresh data.
      setTimeout(() => onChanged?.(), 3500);
    } catch (error) {
      setActionMsg({ kind: 'err', text: error instanceof Error ? error.message : 'Restart failed' });
    } finally {
      setBusy(false);
    }
  };

  const openLogsTab = () => setTab('logs');

  return (
    <Drawer open={open} onClose={onClose} title={service?.name ?? 'Service'} size="lg">
      {service && (
        <div className="space-y-5">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-sm text-muted-foreground">{service.description}</p>
              <p className="mt-1 text-xs text-muted-foreground">
                <span className="font-mono">{service.id}</span>
              </p>
            </div>
            <StatusBadge status={service.status} size="md" />
          </div>

          {/* Tabs */}
          <div className="flex rounded-lg border bg-muted/30 p-1" role="tablist" aria-label="Service views">
            {(['overview', 'logs'] as ServiceTab[]).map(t => (
              <button
                key={t}
                role="tab"
                aria-selected={tab === t}
                onClick={() => setTab(t)}
                className={cn(
                  'flex flex-1 items-center justify-center gap-2 rounded-md px-3 py-1.5 text-xs font-medium capitalize transition-colors',
                  tab === t ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {t === 'logs' && (
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-3.5 w-3.5"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path d="m9 13 2 2 4-4" /></svg>
                )}
                {t === 'logs' ? 'Container logs' : 'Overview'}
              </button>
            ))}
          </div>

          {tab === 'overview' ? (
            <>
              <div className="grid gap-3 rounded-2xl border bg-card p-5 text-sm">
                <InfoRow label="Version" mono>{service.version}</InfoRow>
                <InfoRow label="Environment">{service.environment}</InfoRow>
                <InfoRow label="Owner">{service.owner || '—'}</InfoRow>
                <InfoRow label="Health Score">{service.healthScore}%</InfoRow>
                <InfoRow label="CPU Usage">{service.cpuUsage}%</InfoRow>
                <InfoRow label="Memory Usage">{service.memoryUsage}%</InfoRow>
                <InfoRow label="Memory">{formatBytes(service.memoryBytes)}</InfoRow>
                <InfoRow label="Network Traffic">{formatBytes(service.trafficBytesPerSec)}/s</InfoRow>
                <InfoRow label="Last Restart">{formatRelativeTime(service.lastRestart)}</InfoRow>
                <InfoRow label="Uptime">{formatUptime(service.uptimeSeconds)}</InfoRow>
              </div>

              <div>
                <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Health</h3>
                <div className="mt-2 grid gap-3 rounded-2xl border bg-card p-5 text-sm">
                  <InfoRow label="Latency">{service.health.latencyMs}ms</InfoRow>
                  <InfoRow label="Error Rate" >
                    <span className={service.health.errorRate > 1 ? 'text-danger' : ''}>{service.health.errorRate}%</span>
                  </InfoRow>
                  <InfoRow label="Availability">{service.health.availability}%</InfoRow>
                  <InfoRow label="Last Check">{formatRelativeTime(service.health.checkedAt)}</InfoRow>
                  <div className="flex items-center justify-between gap-4">
                    <span className="text-muted-foreground">Dependencies</span>
                    <span className="flex max-w-[60%] flex-wrap justify-end gap-1">
                      {service.health.dependencies.length ? service.health.dependencies.map(d => (
                        <span key={d} className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">{d}</span>
                      )) : <span className="text-muted-foreground">None</span>}
                    </span>
                  </div>
                </div>
              </div>
            </>
          ) : (
            <div className="rounded-2xl border bg-card">
              <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
                <span className="text-xs font-medium text-muted-foreground">Last 200 lines</span>
                <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => void loadLogs()} disabled={logsLoading}>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-3.5 w-3.5"><path d="M3 3v18h18" /><path d="m19 9-5 5-4-4-3 3" /></svg>
                  {logsLoading ? 'Loading…' : 'Refresh'}
                </Button>
              </div>
              {logsError ? (
                <div className="px-4 py-8 text-center text-sm text-danger">{logsError}</div>
              ) : logsLoading && !logs ? (
                <div className="flex items-center gap-3 px-4 py-8 text-sm text-muted-foreground">
                  <span className="h-2 w-2 animate-pulse-slow rounded-full bg-info" />
                  Fetching container logs…
                </div>
              ) : logs && logs.lines.length > 0 ? (
                <pre className="max-h-[420px] overflow-auto p-4 font-mono text-[11px] leading-relaxed text-muted-foreground scrollbar-thin">
                  {logs.lines.join('\n')}
                </pre>
              ) : (
                <div className="px-4 py-8 text-center text-sm text-muted-foreground">
                  Container has no recent output.
                </div>
              )}
            </div>
          )}

          {actionMsg && (
            <div className={cn('rounded-lg border px-3 py-2 text-xs font-medium', actionMsg.kind === 'ok' ? 'border-success/30 bg-success/10 text-success' : 'border-danger/30 bg-danger/10 text-danger')}>
              {actionMsg.text}
            </div>
          )}

          <div className="flex flex-wrap gap-2 border-t border-border pt-4">
            {confirmingRestart ? (
              <>
                <Button variant="destructive" size="sm" disabled={busy} onClick={() => void doRestart()}>
                  {busy ? 'Restarting…' : 'Confirm restart'}
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setConfirmingRestart(false)}>Cancel</Button>
              </>
            ) : (
              <Button
                variant="secondary"
                size="sm"
                disabled={busy}
                onClick={() => setConfirmingRestart(true)}
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4"><path d="M1 4v6h6" /><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" /></svg>
                Restart
              </Button>
            )}
            <Button variant="outline" size="sm" onClick={openLogsTab}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path d="m9 13 2 2 4-4" /></svg>
              Logs
            </Button>
            <Button variant="outline" size="sm" onClick={() => navigate('/monitoring')}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4"><path d="M3 3v18h18" /><path d="m19 9-5 5-4-4-3 3" /></svg>
              Metrics
            </Button>
          </div>
        </div>
      )}
    </Drawer>
  );
}