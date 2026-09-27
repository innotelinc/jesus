// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

// A pairing step-up (purpose `reauth`) completes at
// /api/auth/reauth/sso/complete only. Handed to the login route, its code
// would sign this browser in as whoever answered the provider's prompt.

vi.mock('@/lib/auth/session-secret', () => ({
  getSessionSecret: () => 's'.repeat(64),
  hasSessionSecret: () => true,
}));
vi.mock('@/lib/logger', () => ({
  logger: { warn: () => {}, error: () => {}, info: () => {}, debug: () => {} },
}));

const jar = new Map<string, string>();
const cookieStore = {
  get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined),
  set: (name: string, value: string) => { jar.set(name, value); },
  delete: (arg: string | { name: string }) => { jar.delete(typeof arg === 'string' ? arg : arg.name); },
  getAll: () => [...jar].map(([name, value]) => ({ name, value })),
};
vi.mock('next/headers', () => ({ cookies: async () => cookieStore }));

const exchangeCodeForTokens = vi.fn();
vi.mock('@/lib/oauth/token-exchange', () => ({
  exchangeCodeForTokens: (...args: unknown[]) => exchangeCodeForTokens(...args),
  getTokenEndpoint: async () => 'https://idp.example.net/token',
  getRequiredConfig: () => ({ clientId: 'webmail', serverUrl: 'https://mail.example.org', discoveryUrl: 'https://idp.example.net' }),
}));

import { encryptPayload } from '@/lib/auth/crypto';
import { POST } from '@/app/api/auth/sso/complete/route';

function pending(extra: Record<string, unknown> = {}) {
  jar.set('sso_pending', encryptPayload({
    state: 'state-1',
    code_verifier: 'verifier-1',
    redirect_uri: 'https://webmail.example/en/auth/callback',
    created_at: Date.now(),
    ...extra,
  }, 'sso-pending'));
}

async function complete() {
  const res = await POST(new NextRequest('https://webmail.example/api/auth/sso/complete', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' },
    body: JSON.stringify({ code: 'code-1', state: 'state-1' }),
  }));
  return { status: res.status, body: await res.json() };
}

beforeEach(() => {
  jar.clear();
  exchangeCodeForTokens.mockReset().mockResolvedValue({ access_token: 'at', refresh_token: 'rt', expires_in: 3600 });
});

describe('/api/auth/sso/complete', () => {
  it('refuses a pairing re-auth and spends nothing', async () => {
    pending({ purpose: 'reauth', slot: 0 });
    const res = await complete();
    expect(res.status).toBe(400);
    expect(exchangeCodeForTokens).not.toHaveBeenCalled();
    expect(jar.has('jmap_rt')).toBe(false);
    expect(jar.has('sso_pending')).toBe(false);
  });

  it('still completes an ordinary login', async () => {
    pending();
    const res = await complete();
    expect(res.status).toBe(200);
    expect(exchangeCodeForTokens).toHaveBeenCalledOnce();
    expect(jar.get('jmap_rt')).toBe('rt');
  });
});
