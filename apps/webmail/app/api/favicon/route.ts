import { NextRequest, NextResponse } from 'next/server';

// In-memory LRU cache: domain -> { data, contentType, fetchedAt }
const CACHE_MAX_SIZE = 1000;
const CACHE_TTL_MS = 14 * 24 * 60 * 60 * 1000; // 2 weeks

interface CacheEntry {
  data: ArrayBuffer;
  contentType: string;
  fetchedAt: number;
}

interface NegativeCacheEntry {
  fetchedAt: number;
}

const cache = new Map<string, CacheEntry>();
const negativeCache = new Map<string, NegativeCacheEntry>();
const NEGATIVE_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 1 day
const NEGATIVE_CACHE_MAX_SIZE = 2000;

// Strict domain validation to prevent SSRF
const DOMAIN_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i;

function isValidDomain(domain: string): boolean {
  if (domain.length > 253) return false;
  if (!DOMAIN_RE.test(domain)) return false;
  // Block internal/private hostnames
  const lower = domain.toLowerCase();
  if (
    lower === 'localhost' ||
    lower.endsWith('.local') ||
    lower.endsWith('.internal') ||
    lower.endsWith('.arpa')
  ) {
    return false;
  }
  return true;
}

// Known multi-part TLDs where the registrable domain includes one extra label.
const MULTI_PART_TLDS = new Set([
  "co.uk", "org.uk", "me.uk", "ac.uk", "gov.uk", "net.uk",
  "co.jp", "or.jp", "ne.jp", "ac.jp", "go.jp",
  "co.kr", "or.kr", "go.kr", "ac.kr",
  "co.in", "net.in", "org.in", "ac.in", "gov.in",
  "co.nz", "org.nz", "net.nz", "govt.nz", "ac.nz",
  "co.za", "org.za", "net.za", "gov.za", "ac.za",
  "com.au", "net.au", "org.au", "edu.au", "gov.au",
  "com.br", "net.br", "org.br", "edu.br", "gov.br",
  "com.cn", "net.cn", "org.cn", "gov.cn", "edu.cn",
  "com.mx", "net.mx", "org.mx", "gob.mx", "edu.mx",
  "com.ar", "net.ar", "org.ar", "gob.ar", "edu.ar",
  "com.tw", "net.tw", "org.tw", "edu.tw", "gov.tw",
  "com.hk", "net.hk", "org.hk", "edu.hk", "gov.hk",
  "com.sg", "net.sg", "org.sg", "edu.sg", "gov.sg",
  "com.my", "net.my", "org.my", "edu.my", "gov.my",
  "com.ph", "net.ph", "org.ph", "edu.ph", "gov.ph",
  "com.pk", "net.pk", "org.pk", "edu.pk", "gov.pk",
  "com.ng", "net.ng", "org.ng", "edu.ng", "gov.ng",
  "co.il", "org.il", "net.il", "ac.il", "gov.il",
  "co.th", "or.th", "ac.th", "go.th", "in.th",
  "co.id", "or.id", "ac.id", "go.id", "web.id",
  "com.tr", "net.tr", "org.tr", "edu.tr", "gov.tr",
  "com.ua", "net.ua", "org.ua", "edu.ua", "gov.ua",
  "com.eg", "net.eg", "org.eg", "edu.eg", "gov.eg",
  "com.sa", "net.sa", "org.sa", "edu.sa", "gov.sa",
  "co.ke", "or.ke", "ac.ke", "go.ke", "ne.ke",
]);

function getRootDomain(domain: string): string {
  const parts = domain.split(".");
  if (parts.length <= 2) return domain;
  const lastTwo = parts.slice(-2).join(".");
  if (MULTI_PART_TLDS.has(lastTwo)) {
    return parts.length >= 3 ? parts.slice(-3).join(".") : domain;
  }
  return parts.slice(-2).join(".");
}

function evictOldest() {
  if (cache.size < CACHE_MAX_SIZE) return;
  // Evict the oldest entry
  let oldestKey: string | null = null;
  let oldestTime = Infinity;
  for (const [key, entry] of cache) {
    if (entry.fetchedAt < oldestTime) {
      oldestTime = entry.fetchedAt;
      oldestKey = key;
    }
  }
  if (oldestKey) cache.delete(oldestKey);
}

export async function GET(request: NextRequest) {
  const domain = request.nextUrl.searchParams.get('domain');

  if (!domain || !isValidDomain(domain)) {
    return new NextResponse(null, {
      status: 400,
      headers: { 'Cache-Control': 'public, max-age=86400' },
    });
  }

  // Resolve to root domain so subdomains share the same favicon lookup
  const normalizedDomain = getRootDomain(domain.toLowerCase());

  // Check negative cache (domains known to have no favicon)
  const neg = negativeCache.get(normalizedDomain);
  if (neg && Date.now() - neg.fetchedAt < NEGATIVE_CACHE_TTL_MS) {
    return new NextResponse(null, {
      status: 404,
      headers: { 'Cache-Control': 'public, max-age=86400' }, // 1 day
    });
  }

  // Check cache
  const cached = cache.get(normalizedDomain);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return new NextResponse(cached.data, {
      headers: {
        'Content-Type': cached.contentType,
        'Cache-Control': 'public, max-age=1209600', // 2 weeks
      },
    });
  }

  try {
    const upstream = await fetch(
      `https://icons.duckduckgo.com/ip3/${encodeURIComponent(normalizedDomain)}.ico`,
      { signal: AbortSignal.timeout(5000) }
    );

    if (!upstream.ok) {
      evictNegativeOldest();
      negativeCache.set(normalizedDomain, { fetchedAt: Date.now() });
      return new NextResponse(null, {
        status: 404,
        headers: { 'Cache-Control': 'public, max-age=86400' },
      });
    }

    const contentType = upstream.headers.get('content-type') || 'image/x-icon';
    const data = await upstream.arrayBuffer();

    // Don't cache empty/tiny responses (likely no real favicon)
    if (data.byteLength < 10) {
      evictNegativeOldest();
      negativeCache.set(normalizedDomain, { fetchedAt: Date.now() });
      return new NextResponse(null, {
        status: 404,
        headers: { 'Cache-Control': 'public, max-age=86400' },
      });
    }

    // Cache the result
    evictOldest();
    cache.set(normalizedDomain, { data, contentType, fetchedAt: Date.now() });

    return new NextResponse(data, {
      headers: {
        'Content-Type': contentType,
        'Cache-Control': 'public, max-age=1209600',
      },
    });
  } catch {
    return new NextResponse(null, {
      status: 502,
      headers: { 'Cache-Control': 'public, max-age=300' }, // 5 min
    });
  }
}

function evictNegativeOldest() {
  if (negativeCache.size < NEGATIVE_CACHE_MAX_SIZE) return;
  let oldestKey: string | null = null;
  let oldestTime = Infinity;
  for (const [key, entry] of negativeCache) {
    if (entry.fetchedAt < oldestTime) {
      oldestTime = entry.fetchedAt;
      oldestKey = key;
    }
  }
  if (oldestKey) negativeCache.delete(oldestKey);
}
