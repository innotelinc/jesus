import { memo } from 'react';
import type { Service } from '../types';
import type { ServiceTab } from './ServiceDetailDrawer';
import StatusBadge from './StatusBadge';
import Button from './Button';
import { cn, formatUptime, formatBytes } from '../lib/utils';

const statusConfig = {
  healthy: { bg: 'bg-success/10', border: 'border-success/30', dot: 'bg-success', accent: 'bg-success' },
  warning: { bg: 'bg-warning/10', border: 'border-warning/30', dot: 'bg-warning', accent: 'bg-warning' },
  critical: { bg: 'bg-danger/10', border: 'border-danger/30', dot: 'bg-danger', accent: 'bg-danger' },
  offline: { bg: 'bg-muted/40', border: 'border-muted', dot: 'bg-muted-foreground', accent: 'bg-muted-foreground' },
} as const;

interface ServiceCardProps {
  service: Service;
  // index is carried for the memo comparator; the stagger is applied by the grid.
  index: number;
  onOpen: (service: Service, tab: ServiceTab) => void;
  onRestart: (service: Service) => void;
  onMetrics: (service: Service) => void;
}

function ServiceCardBase({ service, onOpen, onRestart, onMetrics }: ServiceCardProps) {
  const cfg = statusConfig[service.status];

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onOpen(service, 'overview')}
      onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(service, 'overview'); } }}
      className={cn(
        'group relative cursor-pointer overflow-hidden rounded-2xl border bg-card p-5 text-left transition-all duration-200',
        'hover:-translate-y-0.5 hover:shadow-lg hover:shadow-black/10 hover:border-primary/40',
        cfg.bg,
        cfg.border,
      )}
    >
      <span className={cn('absolute inset-y-0 left-0 w-1', cfg.accent)} />
      <div className="flex items-start justify-between gap-2 pl-1.5">
        <div className="min-w-0 space-y-1.5">
          <div className="flex items-center gap-2">
            <span className={cn('h-2 w-2 shrink-0 rounded-full', cfg.dot)} />
            <h3 className="truncate text-sm font-semibold text-foreground">{service.name}</h3>
          </div>
          <p className="line-clamp-2 text-xs text-muted-foreground">{service.description}</p>
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span className="font-mono">v{service.version}</span>
            <span className="text-muted-foreground/50">·</span>
            <span className="capitalize">{service.environment}</span>
          </div>
        </div>
        <StatusBadge status={service.status} size="sm" showLabel={false} />
      </div>
      <div className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 border-t border-border pt-4 pl-1.5 text-xs">
        <div className="min-w-0 space-y-1">
          <div className="flex items-center justify-between gap-2 text-muted-foreground">
            <span>Health</span>
            <span className="font-medium text-foreground">{service.healthScore}%</span>
          </div>
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
            <div className="h-full rounded-full bg-primary transition-all duration-500" style={{ width: `${service.healthScore}%` }} />
          </div>
        </div>
        <div className="min-w-0 space-y-1">
          <div className="flex items-center justify-between gap-2 text-muted-foreground">
            <span>CPU</span>
            <span className="font-medium text-foreground">{service.cpuUsage}%</span>
          </div>
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
            <div className="h-full rounded-full bg-info transition-all duration-500" style={{ width: `${service.cpuUsage}%` }} />
          </div>
        </div>
        <div className="min-w-0 space-y-1">
          <div className="flex items-center justify-between gap-2 text-muted-foreground">
            <span>Memory</span>
            <span className="font-medium text-foreground">{service.memoryUsage}%</span>
          </div>
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
            <div className="h-full rounded-full bg-accent transition-all duration-500" style={{ width: `${service.memoryUsage}%` }} />
          </div>
        </div>
        <div className="min-w-0 space-y-1">
          <div className="flex items-center justify-between gap-2 text-muted-foreground">
            <span>Traffic</span>
            <span className="font-medium text-foreground">{formatBytes(service.trafficBytesPerSec)}/s</span>
          </div>
        </div>
        <div className="min-w-0 space-y-1">
          <div className="flex items-center justify-between gap-2 text-muted-foreground">
            <span>Last restart</span>
            <span className="font-medium text-foreground">
              {formatUptime(Math.floor((Date.now() - new Date(service.lastRestart).getTime()) / 1000))} ago
            </span>
          </div>
        </div>
      </div>
      <div className="mt-3 flex gap-2 border-t border-border/60 pt-3 pl-1.5 text-xs">
        <Button variant="ghost" size="sm" className="text-muted-foreground hover:text-foreground" onClick={e => { e.stopPropagation(); onOpen(service, 'overview'); }}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-3.5 w-3.5"><circle cx="12" cy="12" r="10" /><path d="M12 8v4l2 2" /></svg>
          Details
        </Button>
        <Button variant="ghost" size="sm" className="text-muted-foreground hover:text-foreground" onClick={e => { e.stopPropagation(); onRestart(service); }}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-3.5 w-3.5"><path d="M1 4v6h6" /><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" /></svg>
          Restart
        </Button>
        <Button variant="ghost" size="sm" className="text-muted-foreground hover:text-foreground" onClick={e => { e.stopPropagation(); onOpen(service, 'logs'); }}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-3.5 w-3.5"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path d="m9 13 2 2 4-4" /></svg>
          Logs
        </Button>
        <Button variant="ghost" size="sm" className="text-muted-foreground hover:text-foreground" onClick={e => { e.stopPropagation(); onMetrics(service); }}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-3.5 w-3.5"><path d="M3 3v18h18" /><path d="m19 9-5 5-4-4-3 3" /></svg>
          Metrics
        </Button>
      </div>
    </div>
  );
}

// The dashboard re-fetches every 30s; skip re-rendering a card entirely when
// none of the fields it displays actually changed. (Handlers are stable
// useCallback props, so they don't invalidate the memo.)
function areServiceEqual(prev: ServiceCardProps, next: ServiceCardProps) {
  const a = prev.service;
  const b = next.service;
  return (
    a.id === b.id &&
    a.name === b.name &&
    a.description === b.description &&
    a.version === b.version &&
    a.environment === b.environment &&
    a.status === b.status &&
    a.healthScore === b.healthScore &&
    a.cpuUsage === b.cpuUsage &&
    a.memoryUsage === b.memoryUsage &&
    a.trafficBytesPerSec === b.trafficBytesPerSec &&
    a.lastRestart === b.lastRestart
  );
}

const ServiceCard = memo(ServiceCardBase, areServiceEqual);
export default ServiceCard;