import { cn } from '../lib/utils';
import type { ReactNode } from 'react';

interface KpiCardProps {
  title: string;
  value: string | number;
  subtitle?: string;
  icon?: ReactNode;
  trend?: { value: number; direction: 'up' | 'down' | 'neutral' };
  color?: 'default' | 'success' | 'warning' | 'danger' | 'info';
  className?: string;
}

export default function KpiCard({ title, value, subtitle, icon, trend, color = 'default', className }: KpiCardProps) {
  const colorMap: Record<string, string> = {
    default: 'bg-primary text-primary-foreground',
    success: 'bg-success text-success-foreground',
    warning: 'bg-warning text-warning-foreground',
    danger: 'bg-danger text-danger-foreground',
    info: 'bg-info text-info-foreground',
  };

  const trendColor = trend?.direction === 'up' ? 'text-success' : trend?.direction === 'down' ? 'text-danger' : 'text-muted-foreground';
  const trendDir = trend?.direction === 'up' ? '↑' : trend?.direction === 'down' ? '↓' : '→';

  return (
    <div className={cn('relative rounded-xl border bg-card p-5 text-sm shadow-sm transition-shadow hover:shadow-md', className)}>
      <div className="flex items-start justify-between">
        <div className="space-y-2">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{title}</p>
          <div className="flex items-baseline gap-2">
            <span className="text-3xl font-semibold tracking-tight">{value}</span>
            {trend && (
              <span className={cn('flex items-center gap-0.5 text-xs font-medium', trendColor)}>
                {trendDir} {Math.abs(trend.value)}%
              </span>
            )}
          </div>
          {subtitle && <p className="text-xs text-muted-foreground">{subtitle}</p>}
        </div>
        {icon && (
          <div className={cn('flex h-10 w-10 items-center justify-center rounded-lg', colorMap[color])}>
            {icon}
          </div>
        )}
      </div>
      <div
        className={cn(
          'absolute bottom-0 left-0 right-0 h-1 rounded-b-xl',
          color === 'success' && 'bg-gradient-to-r from-success/40 to-success',
          color === 'warning' && 'bg-gradient-to-r from-warning/40 to-warning',
          color === 'danger' && 'bg-gradient-to-r from-danger/40 to-danger',
          color === 'info' && 'bg-gradient-to-r from-info/40 to-info',
          color === 'default' && 'bg-primary/40',
        )}
      />
    </div>
  );
}
