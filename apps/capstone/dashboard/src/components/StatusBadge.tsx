import type { ServiceStatus, PortStatus, AlertSeverity, AlertStatus, SecretStatus, ResourceLink } from '../types';
import { cn } from '../lib/utils';

type StatusKind = ServiceStatus | PortStatus | AlertSeverity | AlertStatus | SecretStatus | ResourceLink['status'];

function statusConfig(status: StatusKind): { label: string; colorClass: string; dotClass: string; dotBgClass?: string } {
  switch (status) {
    case 'healthy':
    case 'resolved':
    case 'verified':
    case 'active':
    case 'open':
      return {
        label: 'Healthy',
        colorClass: 'text-success',
        dotClass: 'bg-success',
      };
    case 'warning':
    case 'acknowledged':
    case 'degraded':
    case 'pending':
      return {
        label: 'Warning',
        colorClass: 'text-warning',
        dotClass: 'bg-warning',
      };
    case 'critical':
    case 'escalated':
    case 'expired':
    case 'offline':
      return {
        label: 'Critical',
        colorClass: 'text-danger',
        dotClass: 'bg-danger',
      };    case 'info':
    case 'closed':
    case 'filtered':
      return {
        label: 'Info',
        colorClass: 'text-info',
        dotClass: 'bg-info',
      };
    case 'unknown':
      return {
        label: 'Unknown',
        colorClass: 'text-muted-foreground',
        dotClass: 'bg-muted-foreground',
      };
    case 'rotated':
      return {
        label: 'Rotated',
        colorClass: 'text-info',
        dotClass: 'bg-info',
      };
    default:
      return {
        label: String(status),
        colorClass: 'text-muted-foreground',
        dotClass: 'bg-muted-foreground',
      };
  }
}

interface StatusBadgeProps {
  status: StatusKind;
  showLabel?: boolean;
  size?: 'sm' | 'md';
  className?: string;
}

export default function StatusBadge({ status, showLabel = true, size: _size, className }: StatusBadgeProps) {
  const config = statusConfig(status);
  return (
    <span
      className={cn(
        'inline-flex items-center gap-2 rounded-full px-2.5 py-1 font-medium text-xs transition-colors border',
        className,
      )}
      style={{ borderColor: `hsl(var(--${config.dotClass.replace('bg-', '')}) / 0.3)` }}
    >
      <span className={cn('h-2 w-2 shrink-0 rounded-full', config.dotClass)} />
      {showLabel && <span className={config.colorClass}>{config.label}</span>}
    </span>
  );
}
