import type { ServiceStatus, PortStatus, AlertSeverity, AlertStatus, SecretStatus, ResourceLink, User } from '../types';
import { cn } from '../lib/utils';

type StatusKind = ServiceStatus | PortStatus | AlertSeverity | AlertStatus | SecretStatus | ResourceLink['status'] | User['status'];

function statusConfig(status: StatusKind): { label: string; colorClass: string; dotClass: string; dotBgClass?: string } {
  switch (status) {
    case 'healthy':
      return {
        label: 'Healthy',
        colorClass: 'text-success',
        dotClass: 'bg-success',
      };
    case 'active':
    case 'verified':
      return {
        label: status === 'active' ? 'Active' : 'Verified',
        colorClass: 'text-success',
        dotClass: 'bg-success',
      };
    case 'resolved':
    case 'closed':
      return {
        label: status === 'resolved' ? 'Resolved' : 'Closed',
        colorClass: 'text-success',
        dotClass: 'bg-success',
      };
    case 'open':
    case 'warning':
    case 'degraded':
      return {
        label: status === 'open' ? 'Open' : status === 'degraded' ? 'Degraded' : 'Warning',
        colorClass: 'text-warning',
        dotClass: 'bg-warning',
      };
    case 'acknowledged':
      return {
        label: 'Acknowledged',
        colorClass: 'text-info',
        dotClass: 'bg-info',
      };
    case 'pending':
      return {
        label: 'Pending',
        colorClass: 'text-warning',
        dotClass: 'bg-warning',
      };
    case 'critical':
    case 'escalated':
    case 'expired':
    case 'offline':
    case 'disabled':
      return {
        label: status.charAt(0).toUpperCase() + status.slice(1),
        colorClass: 'text-danger',
        dotClass: 'bg-danger',
      };
    case 'info':
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
