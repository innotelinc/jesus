import { NextRequest, NextResponse } from 'next/server';

// In-memory LRU cache: domain -> { data, contentType, fetchedAt }
const CACHE_MAX_SIZE = 1000;
const CACHE_TTL_MS = 14 * 24 * 60 * 60 * 1000; // 2 weeks

interface CacheEntry {
  data: ArrayBuffer;
  contentType: string;
  fetchedAt: number;
}

const cache = new Map<string, CacheEntry>();

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
    return new NextResponse(null, { status: 400 });
  }

  const normalizedDomain = domain.toLowerCase();

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
      return new NextResponse(null, { status: 404 });
    }

    const contentType = upstream.headers.get('content-type') || 'image/x-icon';
    const data = await upstream.arrayBuffer();

    // Don't cache empty/tiny responses (likely no real favicon)
    if (data.byteLength < 10) {
      return new NextResponse(null, { status: 404 });
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
    return new NextResponse(null, { status: 502 });
  }
}
