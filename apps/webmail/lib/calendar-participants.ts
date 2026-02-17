import type { CalendarEvent, CalendarParticipant } from '@/lib/jmap/types';

export interface ParticipantInfo {
  id: string;
  name: string;
  email: string;
  status: CalendarParticipant['participationStatus'];
  isOrganizer: boolean;
}

export interface StatusCounts {
  accepted: number;
  declined: number;
  tentative: number;
  'needs-action': number;
}

export function isOrganizer(event: CalendarEvent, userEmails: string[]): boolean {
  if (!event.participants) return false;
  const lower = userEmails.map(e => e.toLowerCase());
  return Object.values(event.participants).some(p =>
    p.roles?.owner && lower.includes(p.email?.toLowerCase())
  );
}

export function getUserParticipantId(event: CalendarEvent, userEmails: string[]): string | null {
  if (!event.participants) return null;
  const lower = userEmails.map(e => e.toLowerCase());
  for (const [id, p] of Object.entries(event.participants)) {
    if (lower.includes(p.email?.toLowerCase())) return id;
  }
  return null;
}

export function getUserStatus(
  event: CalendarEvent,
  userEmails: string[]
): CalendarParticipant['participationStatus'] | null {
  if (!event.participants) return null;
  const lower = userEmails.map(e => e.toLowerCase());
  for (const p of Object.values(event.participants)) {
    if (lower.includes(p.email?.toLowerCase())) return p.participationStatus;
  }
  return null;
}

export function getParticipantList(event: CalendarEvent): ParticipantInfo[] {
  if (!event.participants) return [];
  return Object.entries(event.participants).map(([id, p]) => ({
    id,
    name: p.name || '',
    email: p.email || '',
    status: p.participationStatus || 'needs-action',
    isOrganizer: !!p.roles?.owner,
  }));
}

export function getStatusCounts(event: CalendarEvent): StatusCounts {
  const counts: StatusCounts = { accepted: 0, declined: 0, tentative: 0, 'needs-action': 0 };
  if (!event.participants) return counts;
  for (const p of Object.values(event.participants)) {
    const s = p.participationStatus || 'needs-action';
    if (s in counts) counts[s as keyof StatusCounts]++;
  }
  return counts;
}

export function getParticipantCount(event: CalendarEvent): number {
  if (!event.participants) return 0;
  return Object.keys(event.participants).length;
}

export function buildParticipantMap(
  organizer: { name: string; email: string },
  attendees: { name: string; email: string }[]
): Record<string, Partial<CalendarParticipant>> {
  const participants: Record<string, Partial<CalendarParticipant>> = {};

  participants['organizer'] = {
    '@type': 'Participant',
    name: organizer.name,
    email: organizer.email,
    roles: { owner: true, attendee: true },
    participationStatus: 'accepted',
    scheduleAgent: 'server',
    sendTo: { imip: `mailto:${organizer.email}` },
    expectReply: false,
    kind: 'individual',
  };

  attendees.forEach((a, i) => {
    participants[`attendee-${i}`] = {
      '@type': 'Participant',
      name: a.name,
      email: a.email,
      roles: { attendee: true },
      participationStatus: 'needs-action',
      scheduleAgent: 'server',
      sendTo: { imip: `mailto:${a.email}` },
      expectReply: true,
      kind: 'individual',
    };
  });

  return participants;
}
