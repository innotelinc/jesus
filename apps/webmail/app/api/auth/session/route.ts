import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { logger } from '@/lib/logger';
import { encryptSession, decryptSession } from '@/lib/auth/crypto';
import { SESSION_COOKIE_MAX_AGE, sessionCookieName } from '@/lib/auth/session-cookie';

const COOKIE_OPTIONS = {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'lax' as const,
  path: '/',
  maxAge: SESSION_COOKIE_MAX_AGE,
};

function getSlot(request: NextRequest): number {
  const raw = request.nextUrl.searchParams.get('slot');
  if (raw === null) return 0;
  const slot = parseInt(raw, 10);
  if (isNaN(slot) || slot < 0 || slot > 4) return 0;
  return slot;
}

export async function POST(request: NextRequest) {
  try {
    if (process.env.OAUTH_ENABLED === 'true' && process.env.OAUTH_ONLY === 'true') {
      return NextResponse.json({ error: 'Basic authentication is disabled' }, { status: 403 });
    }

    const { serverUrl, username, password, slot: bodySlot } = await request.json();
    if (!serverUrl || !username || !password) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
    }

    const slot = typeof bodySlot === 'number' && bodySlot >= 0 && bodySlot <= 4 ? bodySlot : getSlot(request);
    const cookieName = sessionCookieName(slot);
    const token = encryptSession(serverUrl, username, password);
    const cookieStore = await cookies();
    cookieStore.set(cookieName, token, COOKIE_OPTIONS);

    return NextResponse.json({ ok: true });
  } catch (error) {
    logger.error('Session store error', { error: error instanceof Error ? error.message : 'Unknown error' });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function GET(request: NextRequest) {
  try {
    const slot = getSlot(request);
    const cookieName = sessionCookieName(slot);
    const cookieStore = await cookies();
    const token = cookieStore.get(cookieName)?.value;

    if (!token) {
      return NextResponse.json({ error: 'No session' }, { status: 401 });
    }

    const credentials = decryptSession(token);
    if (!credentials) {
      cookieStore.delete(cookieName);
      return NextResponse.json({ error: 'Invalid session' }, { status: 401 });
    }

    return NextResponse.json(credentials, {
      headers: { 'Cache-Control': 'no-store, no-cache, must-revalidate' },
    });
  } catch (error) {
    logger.error('Session read error', { error: error instanceof Error ? error.message : 'Unknown error' });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const cookieStore = await cookies();
    const all = request.nextUrl.searchParams.get('all') === 'true';

    if (all) {
      // Delete all session cookies (slots 0-4)
      for (let i = 0; i <= 4; i++) {
        cookieStore.delete(sessionCookieName(i));
      }
    } else {
      const slot = getSlot(request);
      cookieStore.delete(sessionCookieName(slot));
    }

    return NextResponse.json({ ok: true });
  } catch (error) {
    logger.error('Session clear error', { error: error instanceof Error ? error.message : 'Unknown error' });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
