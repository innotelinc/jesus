import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Deleting a message in a real folder (e.g. one built from a Sieve `fileinto`
 * rule) could show "Inbox" badges and stale rows blended in, because a
 * still-in-flight fetchUnifiedEmails/fetchCrossView call (kicked off before
 * the user navigated to that folder) resolved AFTER selectMailbox and
 * unconditionally stomped isUnifiedView back to true. The next
 * refreshCurrentMailbox (triggered by the delete's push echo) then took the
 * unified branch instead of refreshing the real folder.
 *
 * viewToken is bumped by every view-changing action; fetchUnifiedEmails and
 * fetchCrossView capture it before their async fetch and bail if it no
 * longer matches on return, so a late response can't clobber a newer view.
 */

const { fetchCrossViewMock, fetchUnifiedMock } = vi.hoisted(() => ({
  fetchCrossViewMock: vi.fn(),
  fetchUnifiedMock: vi.fn(),
}));

vi.mock('@/lib/unified-mailbox', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/unified-mailbox')>();
  return {
    ...actual,
    fetchCrossViewEmails: fetchCrossViewMock,
    fetchUnifiedEmails: fetchUnifiedMock,
  };
});

import { useEmailStore } from '../email-store';
import { useSettingsStore } from '../settings-store';
import type { Email } from '@/lib/jmap/types';
import type { UnifiedAccountClient } from '@/lib/unified-mailbox';

const makeEmail = (id: string): Email =>
  ({
    id,
    threadId: `t-${id}`,
    mailboxIds: { inbox: true },
    keywords: {},
    from: [{ email: 'a@example.com' }],
    to: [{ email: 'b@example.com' }],
    subject: `mail ${id}`,
    receivedAt: '2026-08-13T10:00:00Z',
    preview: '',
    hasAttachment: false,
    size: 1,
  }) as unknown as Email;

describe('viewToken guards against late-resolving unified fetches (#delete-folder-blend)', () => {
  let resolveUnified!: (value: unknown) => void;

  beforeEach(() => {
    vi.clearAllMocks();
    useSettingsStore.setState({ emailsPerPage: 25 });
    useEmailStore.setState({
      emails: [],
      totalEmails: 0,
      isUnifiedView: false,
      unifiedRole: null,
      crossView: null,
      selectedMailbox: '',
      selectedKeyword: null,
    });
    fetchUnifiedMock.mockImplementation(
      () => new Promise((resolve) => { resolveUnified = resolve; }),
    );
  });

  it('a late-resolving fetchUnifiedEmails does not stomp a folder selected afterward', async () => {
    const accounts: UnifiedAccountClient[] = [];

    // Kick off a unified fetch and don't await it yet - simulates it being
    // in flight when the user clicks away.
    const pending = useEmailStore.getState().fetchUnifiedEmails(accounts, 'inbox');
    expect(useEmailStore.getState().isUnifiedView).toBe(true);

    // User navigates to a real folder (e.g. "Later") before the fetch settles.
    useEmailStore.getState().selectMailbox('later-folder-id');
    expect(useEmailStore.getState().isUnifiedView).toBe(false);
    expect(useEmailStore.getState().selectedMailbox).toBe('later-folder-id');

    // The stale unified fetch now resolves.
    resolveUnified({
      emails: [makeEmail('unified-a'), makeEmail('unified-b')],
      hasMore: false,
      total: 2,
      errors: new Map(),
    });
    await pending;

    // It must not have re-entered unified view or overwritten the folder's state.
    expect(useEmailStore.getState().isUnifiedView).toBe(false);
    expect(useEmailStore.getState().selectedMailbox).toBe('later-folder-id');
    expect(useEmailStore.getState().emails.map((e) => e.id)).not.toContain('unified-a');
  });

  it('a fresh fetchUnifiedEmails call still applies its own results normally', async () => {
    fetchUnifiedMock.mockResolvedValueOnce({
      emails: [makeEmail('a')],
      hasMore: false,
      total: 1,
      errors: new Map(),
    });

    await useEmailStore.getState().fetchUnifiedEmails([], 'inbox');

    expect(useEmailStore.getState().isUnifiedView).toBe(true);
    expect(useEmailStore.getState().emails.map((e) => e.id)).toEqual(['a']);
  });
});
