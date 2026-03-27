import { parseISO } from 'date-fns';
import type { CalendarEvent } from '@/lib/jmap/types';

const DURATION_RE = /^P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/;

function isDateOnlyValue(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function isMidnightValue(value: string): boolean {
  if (isDateOnlyValue(value)) {
    return true;
  }

  const match = value.match(/T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})?$/);
  if (!match) {
    return false;
  }

  return match[1] === '00' && match[2] === '00' && (match[3] ?? '00') === '00';
}

function parseDurationSeconds(duration: string | undefined): number | null {
  if (!duration) {
    return null;
  }

  const match = DURATION_RE.exec(duration);
  if (!match) {
    return null;
  }

  const weeks = parseInt(match[1] || '0', 10);
  const days = parseInt(match[2] || '0', 10);
  const hours = parseInt(match[3] || '0', 10);
  const minutes = parseInt(match[4] || '0', 10);
  const seconds = parseInt(match[5] || '0', 10);

  return (((weeks * 7 + days) * 24 + hours) * 60 + minutes) * 60 + seconds;
}

export function normalizeAllDayDurationValue(duration: string | undefined): string | undefined {
  const totalSeconds = parseDurationSeconds(duration);
  if (totalSeconds === null || totalSeconds < 86400 || totalSeconds % 86400 !== 0) {
    return duration;
  }

  return `P${totalSeconds / 86400}D`;
}

export function isAllDayEventLike(event: Pick<Partial<CalendarEvent>, 'start' | 'duration' | 'showWithoutTime'>): boolean {
  if (event.showWithoutTime) {
    return true;
  }

  if (!event.start || !event.duration || !isMidnightValue(event.start)) {
    return false;
  }

  const totalSeconds = parseDurationSeconds(event.duration);
  if (totalSeconds === null || totalSeconds < 86400 || totalSeconds % 86400 !== 0) {
    return false;
  }

  const start = parseISO(event.start);
  if (Number.isNaN(start.getTime())) {
    return false;
  }

  const end = new Date(start.getTime() + totalSeconds * 1000);
  return end.getHours() === 0
    && end.getMinutes() === 0
    && end.getSeconds() === 0
    && end.getMilliseconds() === 0;
}

export function normalizeCalendarEventLike<T extends Partial<CalendarEvent>>(event: T): T {
  if (!isAllDayEventLike(event)) {
    return event;
  }

  return {
    ...event,
    showWithoutTime: true,
    duration: normalizeAllDayDurationValue(event.duration),
  } as T;
}

export function sanitizeOutgoingCalendarEventData<T extends Partial<CalendarEvent>>(event: T): T {
  const normalized = normalizeCalendarEventLike(event);
  if (!normalized.showWithoutTime) {
    return normalized;
  }

  const normalizedStart = normalized.start
    ? `${normalized.start.slice(0, 10)}T00:00:00`
    : normalized.start;

  return {
    ...normalized,
    start: normalizedStart,
    duration: normalizeAllDayDurationValue(normalized.duration),
    timeZone: null,
  } as T;
}