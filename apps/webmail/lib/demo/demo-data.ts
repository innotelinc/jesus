import { cloneFixtures } from './demo-utils';
import { createDemoMailboxes } from './fixtures/mailboxes';
import { createDemoEmails } from './fixtures/emails';
import { createDemoContacts, createDemoAddressBooks } from './fixtures/contacts';
import { createDemoCalendars, createDemoCalendarEvents } from './fixtures/calendars';
import { createDemoIdentities } from './fixtures/identities';
import { createDemoSieveScripts, createDemoSieveCapabilities, createDemoSieveContent } from './fixtures/filters';
import { createDemoFileNodes } from './fixtures/files';
import { createDemoVacationResponse } from './fixtures/vacation';

import type { Email, Mailbox, ContactCard, AddressBook, Calendar, CalendarEvent, Identity, VacationResponse, FileNode } from '@/lib/jmap/types';
import type { SieveScript, SieveCapabilities } from '@/lib/jmap/sieve-types';

export interface DemoData {
  mailboxes: Mailbox[];
  emails: Email[];
  contacts: ContactCard[];
  addressBooks: AddressBook[];
  calendars: Calendar[];
  calendarEvents: CalendarEvent[];
  identities: Identity[];
  sieveScripts: SieveScript[];
  sieveCapabilities: SieveCapabilities;
  sieveContent: Record<string, string>;
  fileNodes: FileNode[];
  vacationResponse: VacationResponse;
}

/** Return a fresh deep-cloned copy of all demo data. */
export function getDemoData(): DemoData {
  return cloneFixtures({
    mailboxes: createDemoMailboxes(),
    emails: createDemoEmails(),
    contacts: createDemoContacts(),
    addressBooks: createDemoAddressBooks(),
    calendars: createDemoCalendars(),
    calendarEvents: createDemoCalendarEvents(),
    identities: createDemoIdentities(),
    sieveScripts: createDemoSieveScripts(),
    sieveCapabilities: createDemoSieveCapabilities(),
    sieveContent: createDemoSieveContent(),
    fileNodes: createDemoFileNodes(),
    vacationResponse: createDemoVacationResponse(),
  });
}
