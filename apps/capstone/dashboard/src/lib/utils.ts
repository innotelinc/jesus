import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatBytes(bytes: number, decimals = 2) {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}

export function formatUptime(seconds: number) {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

export type Verdict = 'pass' | 'review' | 'fail' | 'unknown';

/** Border/text tone for a verdict chip (shared by the reports table + overview widget). */
export function verdictChipClass(verdict: Verdict) {
  return verdict === 'pass'
    ? 'border-success/40 text-success'
    : verdict === 'review'
      ? 'border-warning/40 text-warning'
      : verdict === 'fail'
        ? 'border-danger/40 text-danger'
        : 'border-muted-foreground/30 text-muted-foreground';
}

/** Background tone for the small verdict status dot. */
export function verdictDotClass(verdict: Verdict) {
  return verdict === 'pass'
    ? 'bg-success'
    : verdict === 'review'
      ? 'bg-warning'
      : verdict === 'fail'
        ? 'bg-danger'
        : 'bg-muted-foreground/60';
}

/** Text tone for a 0–100 interview score; muted when the report wasn't scored. */
export function scoreToneClass(score: number | null) {
  if (score === null || Number.isNaN(score)) return 'text-muted-foreground';
  return score >= 75 ? 'text-success' : score >= 60 ? 'text-warning' : 'text-danger';
}

export function formatRelativeTime(date: string | Date) {
  const diff = Date.now() - new Date(date).getTime();
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(date).toLocaleDateString();
}
