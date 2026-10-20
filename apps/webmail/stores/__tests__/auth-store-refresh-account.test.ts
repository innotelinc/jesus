import { beforeAll, beforeEach, expect, it, vi } from 'vitest';

// A token renewal for a background account must be spent on that account's
// cookie slot. Falling back to the active account's slot is what handed a
// second SSO account the first account's token after a page refresh.
vi.mock('@/lib/jmap/client', () => {
  class RequestTimeoutError extends Error {}
  class RateLimitError extends Error {}
  class JMAPClient {
    static withBearer() { throw new Error('not used'); }
    constructor(public serverUrl: string, public username: string, public password: string) {}
    async connect() {}
    getUsername() { return this.username; }
    getAuthHeader() { return 'Bearer x'; }
    onConnectionChange() {}
    onRateLimit() {}
    getRateLimitRemainingMs() { return 0; }
    disconnect() {}
  }
  return { JMAPClient, RateLimitError, RequestTimeoutError };
});
vi.mock('@/lib/stalwart/principal', () => ({ fetchPrincipalDisplayName: async () => null }));

import { useAuthStore } from '@/stores/auth-store';
import { useAccountStore } from '@/stores/account-store';

const SERVER = 'https://mail.x.test';

function account(id: string, slot: number, isDefault: boolean) {
  return {
    id,
    label: id,
    serverUrl: SERVER,
    username: `${id}@x.test`,
    authMode: 'oauth' as const,
    rememberMe: true,
    cookieSlot: slot,
    displayName: id,
    email: `${id}@x.test`,
    isConnected: true,
    hasError: false,
    lastLoginAt: 1,
    avatarColor: '#000000',
    isDefault,
  };
}

const A = account('A', 0, true);
const B = account('B', 1, false);

const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
  const url = String(input);
  if (url.startsWith('/api/auth/token') && init?.method === 'PUT') {
    return new Response(JSON.stringify({ access_token: 'B-new', expires_in: 3600 }), { status: 200 });
  }
  if (url === '/api/auth/stalwart-context') return new Response('{}', { status: 200 });
  return new Response('{}', { status: 200 });
});

beforeAll(() => {
  vi.stubGlobal('fetch', fetchMock);
});

beforeEach(() => {
  fetchMock.mockClear();
  useAccountStore.setState({
    accounts: [A, B] as never,
    activeAccountId: A.id,
    defaultAccountId: A.id,
  });
  useAuthStore.setState({
    isAuthenticated: true,
    isLoading: false,
    error: null,
    serverUrl: SERVER,
    username: 'A@x.test',
    client: null,
    authMode: 'oauth',
    accessToken: 'A-old',
    tokenExpiresAt: null,
    activeAccountId: A.id,
  });
});

it("refreshes the background account's own slot and leaves the active session alone", async () => {
  const token = await useAuthStore.getState().refreshAccessToken({ accountId: B.id });

  expect(token).toBe('B-new');
  const tokenCall = fetchMock.mock.calls.find(([input]) => String(input).startsWith('/api/auth/token'));
  expect(String(tokenCall?.[0])).toContain('slot=1');
  expect(String(tokenCall?.[0])).toContain('force=true');

  // The active account's token is not replaced by B's.
  expect(useAuthStore.getState().accessToken).toBe('A-old');
  expect(useAuthStore.getState().activeAccountId).toBe(A.id);
});

it('marks a background account whose refresh was rejected instead of signing everything out', async () => {
  fetchMock.mockImplementationOnce(async () => new Response('{}', { status: 401 }));

  const token = await useAuthStore.getState().refreshAccessToken({ accountId: B.id });

  expect(token).toBeNull();
  expect(useAuthStore.getState().isAuthenticated).toBe(true);
  expect(useAccountStore.getState().accounts.map((a) => a.id)).toEqual([A.id, B.id]);
  expect(useAccountStore.getState().getAccountById(B.id)).toMatchObject({
    isConnected: false,
    hasError: true,
  });
});
