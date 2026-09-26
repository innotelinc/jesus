import { render, screen, cleanup } from '@testing-library/react';
import { describe, it, expect, afterEach } from 'vitest';
import { EventCard } from '../event-card';
import type { CalendarEvent, CalendarParticipant } from '@/lib/jmap/types';

// #1110: an invitation the user declined - the whole series or one occurrence
// of an accepted series - stays on the calendar, struck through and dimmed
// like a cancelled event, instead of looking like one they will attend.

function makeOccurrence(id: string, myStatus: CalendarParticipant['participationStatus']): CalendarEvent {
  return {
    id,
    '@type': 'Event',
    uid: 'series',
    title: 'Standup ' + id,
    start: '2026-09-28T09:00:00',
    duration: 'PT30M',
    showWithoutTime: false,
    status: 'confirmed',
    calendarIds: { 'cal-1': true },
    participants: {
      org: { '@type': 'Participant', calendarAddress: 'mailto:boss@example.com', participationStatus: 'accepted' },
      me: { '@type': 'Participant', calendarAddress: 'mailto:me@example.com', participationStatus: myStatus },
    },
  } as unknown as CalendarEvent;
}

const me = ['me@example.com'];

describe('EventCard', () => {
  afterEach(() => {
    cleanup();
  });

  it.each(['chip', 'span', 'block'] as const)('strikes through an occurrence the user declined (%s)', (variant) => {
    render(<EventCard event={makeOccurrence('a', 'declined')} variant={variant} currentUserEmails={me} />);
    const card = screen.getByRole('button');
    expect(card).toHaveClass('opacity-60');
    expect(card.getAttribute('aria-label')).toMatch(/, participants\.declined$/);
    expect(screen.getByText('Standup a')).toHaveClass('line-through');
  });

  it('leaves accepted and unanswered occurrences alone', () => {
    render(
      <>
        <EventCard event={makeOccurrence('a', 'accepted')} variant="block" currentUserEmails={me} />
        <EventCard event={makeOccurrence('b', 'needs-action')} variant="block" currentUserEmails={me} />
      </>
    );
    for (const card of screen.getAllByRole('button')) {
      expect(card).not.toHaveClass('opacity-60');
      expect(card.getAttribute('aria-label')).not.toMatch(/declined/);
    }
    expect(screen.getByText('Standup a')).not.toHaveClass('line-through');
  });

  it('only looks at the user\'s own participant entry', () => {
    const event = makeOccurrence('a', 'accepted');
    event.participants!.org.participationStatus = 'declined';
    render(<EventCard event={event} variant="block" currentUserEmails={me} />);
    expect(screen.getByRole('button')).not.toHaveClass('opacity-60');
  });

  it('labels a cancelled event as cancelled even when the user declined it', () => {
    const event = { ...makeOccurrence('a', 'declined'), status: 'cancelled' } as CalendarEvent;
    render(<EventCard event={event} variant="block" currentUserEmails={me} />);
    expect(screen.getByRole('button').getAttribute('aria-label')).toMatch(/, detail\.cancelled$/);
  });
});
