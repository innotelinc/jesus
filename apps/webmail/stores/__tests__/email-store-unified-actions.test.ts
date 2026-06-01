import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useEmailStore } from '../email-store';
import { useAuthStore } from '../auth-store';
import type { Email, Mailbox } from '@/lib/jmap/types';
import type { IJMAPClient } from '@/lib/jmap/client-interface';

// Regression coverage for issue #281: single-email actions performed in the
// unified inbox must be routed to the *email's own account* client, not the
// active account's. Sending them to the active account silently no-ops
// server-side (JMAP returns notUpdated without throwing), so the change is lost
// on the next reload.

function makeMailbox(overrides: Partial<Mailbox> = {}): Mailbox {
  return {
    id: 'inbox',
    name: 'Inbox',
    sortOrder: 0,
    totalEmails: 0,
    unreadEmails: 0,
    totalThreads: 0,
    unreadThreads: 0,
    myRights: {
      mayReadItems: true,
      mayAddItems: true,
      mayRemoveItems: true,
      maySetSeen: true,
      maySetKeywords: true,
      mayCreateChild: true,
      mayRename: true,
      mayDelete: true,
      maySubmit: true,
    },
    isSubscribed: true,
    isShared: false,
    ...overrides,
  };
}

function makeEmail(overrides: Partial<Email> = {}): Email {
  return {
    id: 'email-1',
    threadId: 'thread-1',
    subject: 'Hi',
    receivedAt: new Date().toISOString(),
    keywords: {},
    mailboxIds: {},
    ...overrides,
  } as Email;
}

function makeClient() {
  return {
    markAsRead: vi.fn().mockResolvedValue(undefined),
    toggleStar: vi.fn().mockResolvedValue(undefined),
    moveEmail: vi.fn().mockResolvedValue(undefined),
  } as unknown as IJMAPClient;
}

describe('unified-view single-email action routing (#281)', () => {
  let activeClient: IJMAPClient; // account-a, also the "passed" client
  let accountBClient: IJMAPClient;

  beforeEach(() => {
    activeClient = makeClient();
    accountBClient = makeClient();

    // Route account-b to its own client; account-a falls back to the active one.
    useAuthStore.setState({
      getClientForAccount: (id: string) =>
        (id === 'account-b' ? accountBClient : undefined) as never,
    } as never);

    useEmailStore.setState({
      isUnifiedView: true,
      unifiedRole: 'inbox',
      viewingAccountId: null,
      selectedMailbox: '',
      mailboxes: [makeMailbox({ id: 'a-inbox', role: 'inbox' })],
      accountMailboxes: {
        'account-a': [makeMailbox({ id: 'a-inbox', role: 'inbox' })],
        'account-b': [
          makeMailbox({ id: 'b-inbox', role: 'inbox' }),
          makeMailbox({ id: 'b-archive', name: 'Archive', role: 'archive' }),
        ],
      },
      processingReadStatus: new Set(),
      selectedEmail: null,
      selectedEmailIds: new Set(),
      emails: [
        makeEmail({ id: 'email-b', accountId: 'account-b', keywords: {}, mailboxIds: { 'b-inbox': true } }),
      ],
    });
  });

  it('routes markAsRead to the email’s account client', async () => {
    await useEmailStore.getState().markAsRead(activeClient, 'email-b', true);

    expect(accountBClient.markAsRead).toHaveBeenCalledWith('email-b', true, undefined);
    expect(activeClient.markAsRead).not.toHaveBeenCalled();
  });

  it('routes toggleStar to the email’s account client', async () => {
    await useEmailStore.getState().toggleStar(activeClient, 'email-b');

    expect(accountBClient.toggleStar).toHaveBeenCalledWith('email-b', true);
    expect(activeClient.toggleStar).not.toHaveBeenCalled();
  });

  it('routes moveToMailbox to the email’s account client with that account’s destination', async () => {
    await useEmailStore.getState().moveToMailbox(activeClient, 'email-b', 'b-archive');

    expect(accountBClient.moveEmail).toHaveBeenCalledWith('email-b', 'b-archive', undefined);
    expect(activeClient.moveEmail).not.toHaveBeenCalled();
  });

  it('still uses the active/passed client outside unified view', async () => {
    useEmailStore.setState({
      isUnifiedView: false,
      emails: [makeEmail({ id: 'email-a', accountId: 'account-a', mailboxIds: { 'a-inbox': true } })],
    });

    await useEmailStore.getState().markAsRead(activeClient, 'email-a', true);

    expect(activeClient.markAsRead).toHaveBeenCalledWith('email-a', true, undefined);
    expect(accountBClient.markAsRead).not.toHaveBeenCalled();
  });
});
