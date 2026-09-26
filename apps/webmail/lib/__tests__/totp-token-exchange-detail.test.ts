// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

// On a failed login the route handed back the first 500 bytes of the
// upstream error body. With custom JMAP endpoints on and no configured
// server, the upstream is any address the caller names, so the route read
// other servers' responses for them.

vi.mock('@/lib/logger', () => ({
  logger: { warn: () => {}, error: () => {}, info: () => {}, debug: () => {} },
}));
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => undefined, set: () => {}, delete: () => {} }),
}));
vi.mock('@/lib/telemetry/login-tracker', () => ({ recordLogin: () => {} }));

const config: Record<string, unknown> = {};
vi.mock('@/lib/admin/config-manager', () => ({
  configManager: {
    ensureLoaded: async () => {},
    get: (key: string, fallback: unknown) => (key in config ? config[key] : fallback),
  },
}));

const upstream = vi.fn();
vi.mock('@/lib/security/url-guard', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/security/url-guard')>();
  return {
    ...actual,
    isPublicHttpUrl: async () => true,
    fetchPublicUrl: (...args: unknown[]) => upstream(...args),
  };
});

const SECRET_BODY = 'internal admin page: api-key=sk_live_123';

function login(serverUrl: string) {
  return new NextRequest('https://webmail.example/api/auth/totp-token-exchange', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' },
    body: JSON.stringify({ serverUrl, username: 'u', password: 'p', totp: '123456' }),
  });
}

beforeEach(() => {
  for (const key of Object.keys(config)) delete config[key];
  upstream.mockReset().mockResolvedValue(new Response(SECRET_BODY, { status: 403 }));
  vi.stubGlobal('fetch', vi.fn(async () => new Response(SECRET_BODY, { status: 403 })));
});

describe('totp-token-exchange error detail', () => {
  it('does not reflect the body of a user-chosen server', async () => {
    config.allowCustomJmapEndpoint = true;
    const { POST } = await import('@/app/api/auth/totp-token-exchange/route');
    const res = await POST(login('https://somewhere.example'));
    expect(res.status).toBe(502);
    expect(JSON.stringify(await res.json())).not.toContain('sk_live_123');
  });

  it('still shows the start of the error from a configured server', async () => {
    config.jmapServerUrl = 'https://mail.example.org';
    const { POST } = await import('@/app/api/auth/totp-token-exchange/route');
    const res = await POST(login('https://mail.example.org'));
    expect((await res.json()).detail).toBe(SECRET_BODY);
  });
});
