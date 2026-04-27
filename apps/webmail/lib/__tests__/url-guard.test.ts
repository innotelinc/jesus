import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const lookup = vi.fn();

vi.mock('node:dns/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:dns/promises')>();
  return {
    ...actual,
    default: { ...actual, lookup: (...args: unknown[]) => lookup(...args) },
    lookup: (...args: unknown[]) => lookup(...args),
  };
});

describe('isPublicHttpUrl', () => {
  beforeEach(() => {
    lookup.mockReset();
  });

  afterEach(() => {
    vi.resetModules();
  });

  async function load() {
    const mod = await import('@/lib/security/url-guard');
    return mod.isPublicHttpUrl;
  }

  it('accepts public https URLs whose DNS resolves to a public address', async () => {
    lookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
    const isPublicHttpUrl = await load();
    expect(await isPublicHttpUrl('https://example.com/jmap')).toBe(true);
  });

  it('rejects malformed URLs', async () => {
    const isPublicHttpUrl = await load();
    expect(await isPublicHttpUrl('not a url')).toBe(false);
    expect(await isPublicHttpUrl('')).toBe(false);
  });

  it('rejects non-http(s) protocols', async () => {
    const isPublicHttpUrl = await load();
    expect(await isPublicHttpUrl('file:///etc/passwd')).toBe(false);
    expect(await isPublicHttpUrl('gopher://example.com/')).toBe(false);
    expect(await isPublicHttpUrl('javascript:alert(1)')).toBe(false);
  });

  it('rejects URLs with embedded credentials', async () => {
    const isPublicHttpUrl = await load();
    expect(await isPublicHttpUrl('https://user:pass@example.com/')).toBe(false);
    expect(await isPublicHttpUrl('https://user@example.com/')).toBe(false);
  });

  it('rejects loopback hostnames without DNS', async () => {
    const isPublicHttpUrl = await load();
    expect(await isPublicHttpUrl('http://localhost/')).toBe(false);
    expect(await isPublicHttpUrl('http://service.localhost/')).toBe(false);
    expect(await isPublicHttpUrl('http://server.local/')).toBe(false);
    expect(await isPublicHttpUrl('http://kube.internal/api')).toBe(false);
    expect(await isPublicHttpUrl('http://1.0.0.127.in-addr.arpa/')).toBe(false);
    expect(lookup).not.toHaveBeenCalled();
  });

  it('rejects literal IPv4 loopback and RFC-1918 ranges', async () => {
    const isPublicHttpUrl = await load();
    expect(await isPublicHttpUrl('http://127.0.0.1/')).toBe(false);
    expect(await isPublicHttpUrl('http://10.0.0.5/')).toBe(false);
    expect(await isPublicHttpUrl('http://10.255.255.255/')).toBe(false);
    expect(await isPublicHttpUrl('http://172.16.0.1/')).toBe(false);
    expect(await isPublicHttpUrl('http://172.31.255.254/')).toBe(false);
    expect(await isPublicHttpUrl('http://192.168.1.1/')).toBe(false);
    expect(await isPublicHttpUrl('http://0.0.0.0/')).toBe(false);
    expect(lookup).not.toHaveBeenCalled();
  });

  it('rejects literal AWS / GCP / Azure metadata IP', async () => {
    const isPublicHttpUrl = await load();
    expect(await isPublicHttpUrl('http://169.254.169.254/latest/meta-data/')).toBe(false);
    expect(await isPublicHttpUrl('http://169.254.0.1/')).toBe(false);
    expect(lookup).not.toHaveBeenCalled();
  });

  it('rejects IPv6 loopback, ULA, and link-local literals', async () => {
    const isPublicHttpUrl = await load();
    expect(await isPublicHttpUrl('http://[::1]/')).toBe(false);
    expect(await isPublicHttpUrl('http://[::]/')).toBe(false);
    expect(await isPublicHttpUrl('http://[fc00::1]/')).toBe(false);
    expect(await isPublicHttpUrl('http://[fd12:3456::1]/')).toBe(false);
    expect(await isPublicHttpUrl('http://[fe80::1]/')).toBe(false);
    expect(lookup).not.toHaveBeenCalled();
  });

  it('rejects when DNS resolves to a private address (rebinding)', async () => {
    lookup.mockResolvedValue([{ address: '127.0.0.1', family: 4 }]);
    const isPublicHttpUrl = await load();
    expect(await isPublicHttpUrl('https://evil.example.com/')).toBe(false);
  });

  it('rejects when any resolved address is private (mixed)', async () => {
    lookup.mockResolvedValue([
      { address: '93.184.216.34', family: 4 },
      { address: '10.0.0.1', family: 4 },
    ]);
    const isPublicHttpUrl = await load();
    expect(await isPublicHttpUrl('https://mixed.example.com/')).toBe(false);
  });

  it('rejects when DNS resolves to IPv6 loopback', async () => {
    lookup.mockResolvedValue([{ address: '::1', family: 6 }]);
    const isPublicHttpUrl = await load();
    expect(await isPublicHttpUrl('https://evil6.example.com/')).toBe(false);
  });

  it('rejects when DNS lookup throws', async () => {
    lookup.mockRejectedValue(new Error('ENOTFOUND'));
    const isPublicHttpUrl = await load();
    expect(await isPublicHttpUrl('https://nonexistent.example.com/')).toBe(false);
  });

  it('rejects when DNS returns no records', async () => {
    lookup.mockResolvedValue([]);
    const isPublicHttpUrl = await load();
    expect(await isPublicHttpUrl('https://empty.example.com/')).toBe(false);
  });
});
