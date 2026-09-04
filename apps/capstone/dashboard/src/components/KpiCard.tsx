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
    default: 'bg-gradient-to-br from-primary to-info text-primary-foreground',
    success: 'bg-gradient-to-br from-success/90 to-success/60 text-success-foreground',
    warning: 'bg-gradient-to-br from-warning/90 to-warning/60 text-warning-foreground',
    danger: 'bg-gradient-to-br from-danger/90 to-danger/60 text-danger-foreground',
    info: 'bg-gradient-to-br from-info/90 to-info/60 text-info-foreground',
  };

  const trendColor = trend?.direction === 'up' ? 'text-success' : trend?.direction === 'down' ? 'text-danger' : 'text-muted-foreground';
  const trendDir = trend?.direction === 'up' ? '↑' : trend?.direction === 'down' ? '↓' : '→';

  return (
    <div className={cn('group relative overflow-hidden rounded-2xl border bg-card p-5 text-sm shadow-sm transition-all duration-200 hover:-translate-y-0.5 hover:shadow-lg hover:shadow-black/5', className)}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 space-y-2">
          <p className="truncate text-xs font-medium uppercase tracking-wide text-muted-foreground">{title}</p>
          <div className="flex items-baseline gap-2">
            <span className="text-2xl font-bold tracking-tight sm:text-3xl">{value}</span>
            {trend && (
              <span className={cn('flex items-center gap-0.5 text-xs font-medium', trendColor)}>
                {trendDir} {Math.abs(trend.value)}%
              </span>
            )}
          </div>
          {subtitle && <p className="truncate text-xs text-muted-foreground">{subtitle}</p>}
        </div>
        {icon && (
          <div className={cn('flex h-10 w-10 shrink-0 items-center justify-center rounded-xl shadow-sm', colorMap[color])}>
            {icon}
          </div>
        )}
      </div>
      <div
        className={cn(
          'absolute inset-x-0 bottom-0 h-[2px]',
          color === 'success' && 'bg-gradient-to-r from-success/0 via-success to-success/0',
          color === 'warning' && 'bg-gradient-to-r from-warning/0 via-warning to-warning/0',
          color === 'danger' && 'bg-gradient-to-r from-danger/0 via-danger to-danger/0',
          color === 'info' && 'bg-gradient-to-r from-info/0 via-info to-info/0',
          color === 'default' && 'bg-gradient-to-r from-primary/0 via-primary/60 to-primary/0',
        )}
      />
    </div>
  );
}
