import { describe, expect, it } from 'vitest';
import type { CalendarEvent } from '@/lib/jmap/types';
import {
  isAllDayEventLike,
  normalizeCalendarEventLike,
  sanitizeOutgoingCalendarEventData,
} from '../calendar-event-normalization';

function makeEvent(overrides: Partial<CalendarEvent> = {}): Partial<CalendarEvent> {
  return {
    start: '2026-03-16T00:00:00',
    duration: 'PT24H',
    showWithoutTime: false,
    timeZone: null,
    ...overrides,
  };
}

describe('calendar event normalization', () => {
  it('infers all-day events from midnight-to-midnight spans without the flag', () => {
    expect(isAllDayEventLike(makeEvent())).toBe(true);
  });

  it('does not infer all-day for midnight events with non-day durations', () => {
    expect(isAllDayEventLike(makeEvent({ duration: 'PT12H' }))).toBe(false);
  });

  it('normalizes inferred all-day durations to day units', () => {
    expect(normalizeCalendarEventLike(makeEvent({ duration: 'PT48H' }))).toMatchObject({
      showWithoutTime: true,
      duration: 'P2D',
    });
  });

  it('sanitizes outgoing all-day starts to date-only values', () => {
    expect(sanitizeOutgoingCalendarEventData(makeEvent({
      showWithoutTime: true,
      start: '2026-03-16T00:00:00',
      duration: 'PT24H',
      timeZone: 'UTC',
    }))).toMatchObject({
      start: '2026-03-16T00:00:00',
      duration: 'P1D',
      timeZone: null,
      showWithoutTime: true,
    });
  });
});