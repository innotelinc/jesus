import type { MetricPoint } from '../types';
import { cn } from '../lib/utils';

interface ChartProps {
  data: MetricPoint[];
  color?: string;
  height?: number;
  className?: string;
  showArea?: boolean;
  formatY?: (value: number) => string;
}

export default function Chart({ data, color = 'hsl(var(--primary))', height = 120, className, showArea = true, formatY }: ChartProps) {
  if (!data.length) return null;

  const width = data.length * 6 + 24;
  const padding = 4;
  const values = data.map(d => d.value);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;

  const x = (i: number) => padding + i * 6;
  const y = (v: number) => height - padding - ((v - min) / range) * (height - padding * 2);

  const line = data.map((d, i) => `${i === 0 ? 'M' : 'L'} ${x(i)} ${y(d.value)}`).join(' ');

  const area = showArea ? `${line} L ${x(data.length - 1)} ${height} L ${x(0)} ${height} Z` : line;

  const yTicks = 3;
  const ticks = Array.from({ length: yTicks + 1 }, (_, i) => min + (range * i) / yTicks);

  return (
    <div className={cn('w-full overflow-hidden', className)}>
      <svg width={width} height={height + 16} className="overflow-visible">
        <defs>
          <linearGradient id="chartGradient" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity={0.25} />
            <stop offset="100%" stopColor={color} stopOpacity={0} />
          </linearGradient>
        </defs>
        {ticks.map((t, i) => (
          <g key={i}>
            <text x={2} y={y(t) + 10} className="text-[9px] fill-muted-foreground">{formatY ? formatY(t) : t.toFixed(0)}</text>
            <line x1={0} y1={y(t)} x2={width - 4} y2={y(t)} stroke="hsl(var(--border))" strokeOpacity={0.4} />
          </g>
        ))}
        {showArea && (
          <path d={area} fill="url(#chartGradient)" />
        )}
        <path d={line} fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
        {data.map((d, i) => (
          <circle key={i} cx={x(i)} cy={y(d.value)} r={2} fill={color} />
        ))}
      </svg>
    </div>
  );
}
