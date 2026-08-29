import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { JMAPClient } from '../jmap/client';

/**
 * Request shapes of the JMAP features layered on the core client: delta sync
 * (Email/changes, Mailbox/changes), search snippets (SearchSnippet/get) and
 * folder sharing (mail:share). Each asserts what goes over the wire and how
 * the response is mapped back.
 */

function makeSession(accountCapabilities: Record<string, unknown> = {}) {
  return {
    capabilities: { 'urn:ietf:params:jmap:core': {} },
    accounts: {
      'acct-1': {
        name: 'test',
        isPersonal: true,
        accountCapabilities: { 'urn:ietf:params:jmap:mail': {}, ...accountCapabilities },
      },
    },
    primaryAccounts: { 'urn:ietf:params:jmap:mail': 'acct-1' },
    apiUrl: 'https://mail.example.com/jmap/api',
    downloadUrl: 'https://mail.example.com/jmap/download/{accountId}/{blobId}/{name}',
    uploadUrl: 'https://mail.example.com/jmap/upload/{accountId}/',
    eventSourceUrl: '',
  };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

type RequestBody = { using: string[]; methodCalls: [string, Record<string, unknown>, string][] };

describe('JMAP client extensions', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  let client: JMAPClient;
  let requests: RequestBody[];

  async function setup(accountCapabilities: Record<string, unknown> = {}) {
    fetchSpy = vi.spyOn(globalThis, 'fetch');
    fetchSpy.mockResolvedValueOnce(jsonResponse(makeSession(accountCapabilities)));
    client = new JMAPClient('https://mail.example.com', 'user@test.com', 'pass123');
    await client.connect();
    fetchSpy.mockReset();
    requests = [];
  }

  function answer(handler: (body: RequestBody) => unknown) {
    fetchSpy.mockImplementation(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as RequestBody;
      requests.push(body);
      return jsonResponse(handler(body));
    });
  }

  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    client?.disconnect();
    vi.restoreAllMocks();
  });

  describe('delta sync', () => {
    it('maps Email/changes and passes sinceState / maxChanges', async () => {
      await setup();
      answer(() => ({
        methodResponses: [[
          'Email/changes',
          { accountId: 'acct-1', oldState: 's1', newState: 's2', hasMoreChanges: false, created: ['a'], updated: ['b'], destroyed: ['c'] },
          '0',
        ]],
      }));

      const delta = await client.getEmailChanges('s1', undefined, 200);

      expect(requests[0].methodCalls[0]).toEqual(['Email/changes', { accountId: 'acct-1', sinceState: 's1', maxChanges: 200 }, '0']);
      expect(delta).toEqual({
        oldState: 's1', newState: 's2', hasMoreChanges: false,
        created: ['a'], updated: ['b'], destroyed: ['c'], updatedProperties: null,
      });
    });

    it('returns null when the server cannot calculate the delta', async () => {
      await setup();
      answer(() => ({ methodResponses: [['error', { type: 'cannotCalculateChanges' }, '0']] }));
      expect(await client.getMailboxChanges('old')).toBeNull();
    });

    it('surfaces updatedProperties from Mailbox/changes', async () => {
      await setup();
      answer(() => ({
        methodResponses: [[
          'Mailbox/changes',
          { oldState: 'm1', newState: 'm2', hasMoreChanges: false, created: [], updated: ['inbox'], destroyed: [], updatedProperties: ['totalEmails', 'unreadEmails'] },
          '0',
        ]],
      }));
      const delta = await client.getMailboxChanges('m1');
      expect(delta?.updatedProperties).toEqual(['totalEmails', 'unreadEmails']);
    });

    it('reports the Mailbox state per account from getAllMailboxesWithState', async () => {
      await setup();
      answer(() => ({
        methodResponses: [['Mailbox/get', { accountId: 'acct-1', state: 'm7', list: [{ id: 'inbox', name: 'Inbox', role: 'inbox' }] }, '0']],
      }));
      const { mailboxes, states } = await client.getAllMailboxesWithState();
      expect(mailboxes.map((m) => m.id)).toEqual(['inbox']);
      expect(states).toEqual({ 'acct-1': 'm7' });
    });

    it('reports the Email state a page was read at', async () => {
      await setup();
      answer(() => ({
        methodResponses: [
          ['Email/query', { ids: ['e1'], total: 1 }, '0'],
          ['Email/get', { state: 'e9', list: [{ id: 'e1', threadId: 't1', receivedAt: '2026-08-29T00:00:00Z', mailboxIds: { inbox: true }, keywords: {} }] }, '1'],
        ],
      }));
      const page = await client.getEmails('inbox');
      expect(page.state).toBe('e9');
      expect(page.emails).toHaveLength(1);
    });
  });

  describe('search snippets', () => {
    it('chains SearchSnippet/get onto a text search and attaches the hits', async () => {
      await setup();
      answer(() => ({
        methodResponses: [
          ['Email/query', { ids: ['e1', 'e2'], total: 2 }, '0'],
          ['Email/get', { list: [
            { id: 'e1', threadId: 't1', receivedAt: '2026-08-29T00:00:00Z', subject: 'Invoice', mailboxIds: {}, keywords: {} },
            { id: 'e2', threadId: 't2', receivedAt: '2026-08-28T00:00:00Z', subject: 'Other', mailboxIds: {}, keywords: {} },
          ] }, '1'],
          ['SearchSnippet/get', { list: [
            { emailId: 'e1', subject: '<mark>Invoice</mark>', preview: 'your <mark>invoice</mark> is attached' },
            { emailId: 'e2', subject: null, preview: null },
          ] }, 'snippets'],
        ],
      }));

      const result = await client.searchEmails('invoice', 'inbox');

      const snippetCall = requests[0].methodCalls[2];
      expect(snippetCall[0]).toBe('SearchSnippet/get');
      expect(snippetCall[1]).toEqual({
        accountId: 'acct-1',
        // The wildcard the search adds for prefix matching is stripped again.
        filter: { operator: 'AND', conditions: [{ inMailbox: 'inbox' }, { text: 'invoice' }] },
        '#emailIds': { resultOf: '0', name: 'Email/query', path: '/ids' },
      });
      expect(result.emails[0].searchSnippet).toEqual({ subject: '<mark>Invoice</mark>', preview: 'your <mark>invoice</mark> is attached' });
      expect(result.emails[1].searchSnippet).toBeUndefined();
    });

    it('sends a no-op instead of SearchSnippet/get for a structural filter', async () => {
      await setup();
      answer(() => ({
        methodResponses: [
          ['Email/query', { ids: [], total: 0 }, '0'],
          ['Email/get', { list: [] }, '1'],
          ['Core/echo', {}, 'snippets'],
        ],
      }));
      await client.advancedSearchEmails({ operator: 'AND', conditions: [{ inMailbox: 'inbox' }, { hasKeyword: '$flagged' }] });
      expect(requests[0].methodCalls[2][0]).toBe('Core/echo');
    });

    it('keeps the results when only the snippet call fails', async () => {
      await setup();
      answer(() => ({
        methodResponses: [
          ['Email/query', { ids: ['e1'], total: 1 }, '0'],
          ['Email/get', { list: [{ id: 'e1', threadId: 't1', receivedAt: '2026-08-29T00:00:00Z', mailboxIds: {}, keywords: {} }] }, '1'],
          ['error', { type: 'requestTooLarge' }, 'snippets'],
        ],
      }));
      const result = await client.searchEmails('hello');
      expect(result.emails).toHaveLength(1);
      expect(result.emails[0].searchSnippet).toBeUndefined();
    });
  });

  describe('mailbox sharing', () => {
    it('is advertised only with the mail:share capability', async () => {
      await setup();
      expect(client.supportsMailboxSharing()).toBe(false);
      client.disconnect();
      vi.restoreAllMocks();
      await setup({ 'urn:ietf:params:jmap:mail:share': {} });
      expect(client.supportsMailboxSharing()).toBe(true);
    });

    it('reads shareWith with the extension in `using`', async () => {
      await setup({ 'urn:ietf:params:jmap:mail:share': {} });
      answer(() => ({
        methodResponses: [['Mailbox/get', { list: [{ id: 'f1', shareWith: { p1: { mayReadItems: true } } }] }, '0']],
      }));

      const shareWith = await client.getMailboxShareWith('f1');

      expect(requests[0].using).toContain('urn:ietf:params:jmap:mail:share');
      expect(requests[0].methodCalls[0]).toEqual(['Mailbox/get', { accountId: 'acct-1', ids: ['f1'], properties: ['id', 'shareWith'] }, '0']);
      expect(shareWith).toEqual({ p1: { mayReadItems: true } });
    });

    it('patches shareWith/{principal} on the owner account and checks the outcome', async () => {
      await setup({ 'urn:ietf:params:jmap:mail:share': {} });
      answer(() => ({ methodResponses: [['Mailbox/set', { updated: { f1: null } }, '0']] }));

      await client.setMailboxShare('f1', 'p1', null, 'owner');
      expect(requests[0].methodCalls[0]).toEqual(['Mailbox/set', { accountId: 'owner', update: { f1: { 'shareWith/p1': null } } }, '0']);

      answer(() => ({ methodResponses: [['Mailbox/set', { notUpdated: { f1: { type: 'forbidden', description: 'no' } } }, '0']] }));
      await expect(client.setMailboxShare('f1', 'p1', null)).rejects.toThrow('no');
    });
  });
});
