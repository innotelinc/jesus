import type { Service } from '../../types';
import { Link } from 'react-router-dom';
import StatusBadge from '../../components/StatusBadge';
import Button from '../../components/Button';
import { cn, formatUptime, formatBytes } from '../../lib/utils';

export default function ServiceCard({ service }: { service: Service }) {
  return (
    <Link to="/services" className="group rounded-xl border border-muted bg-card p-5 transition-all hover:shadow-md hover:border-primary/40">
      <div className="flex items-start justify-between">
        <div className="space-y-1.5">
          <div className="flex items-center gap-2">
            <div className={cn(
              'h-2 w-2 rounded-full',
              service.status === 'healthy' && 'bg-success',
              service.status === 'warning' && 'bg-warning',
              service.status === 'critical' && 'bg-danger',
              service.status === 'offline' && 'bg-muted-foreground',
            )} />
            <h3 className="text-sm font-semibold">{service.name}</h3>
            <StatusBadge status={service.status} size="sm" />
          </div>
          <p className="text-xs text-muted-foreground line-clamp-2">{service.description}</p>
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span>v{service.version}</span>
            <span className="text-muted-foreground/50">·</span>
            <span>{service.environment}</span>
            <span className="text-muted-foreground/50">·</span>
            <span>{service.owner}</span>
          </div>
        </div>
      </div>
      <div className="mt-4 flex flex-wrap gap-4 border-t border-border pt-4 text-xs">
        <div className="space-y-1">
          <div className="flex items-center justify-between text-muted-foreground">
            <span>Health</span>
            <span className="font-medium">{service.healthScore}%</span>
          </div>
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
            <div className="h-full rounded-full bg-primary" style={{ width: `${service.healthScore}%` }} />
          </div>
        </div>
        <div className="space-y-1">
          <div className="flex items-center justify-between text-muted-foreground">
            <span>CPU</span>
            <span className="font-medium">{service.cpuUsage}%</span>
          </div>
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
            <div className="h-full rounded-full bg-info" style={{ width: `${service.cpuUsage}%` }} />
          </div>
        </div>
        <div className="space-y-1">
          <div className="flex items-center justify-between text-muted-foreground">
            <span>Memory</span>
            <span className="font-medium">{service.memoryUsage}%</span>
          </div>
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
            <div className="h-full rounded-full bg-accent" style={{ width: `${service.memoryUsage}%` }} />
          </div>
        </div>
        <div className="space-y-1">
          <div className="flex items-center justify-between text-muted-foreground">
            <span>Traffic</span>
            <span className="font-medium">{formatBytes(service.trafficBytesPerSec)}/s</span>
          </div>
        </div>
        <div className="space-y-1">
          <div className="flex items-center justify-between text-muted-foreground">
            <span>Last restart</span>
            <span className="font-medium">{formatUptime(Math.floor((Date.now() - new Date(service.lastRestart).getTime()) / 1000))} ago</span>
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
