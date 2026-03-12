import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { logger } from '@/lib/logger';
import { decryptSession, encryptSession } from '@/lib/auth/crypto';
import { SESSION_COOKIE, SESSION_COOKIE_MAX_AGE } from '@/lib/auth/session-cookie';

const COOKIE_OPTIONS = {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'lax' as const,
  path: '/',
  maxAge: SESSION_COOKIE_MAX_AGE,
};

async function getCredentials(request: NextRequest): Promise<{ serverUrl: string; authHeader: string; username: string; hasSessionCookie: boolean } | null> {
  const authHeader = request.headers.get('Authorization');
  const serverUrl = request.headers.get('X-JMAP-Server-URL');
  const username = request.headers.get('X-JMAP-Username');

  if (authHeader && serverUrl && username) {
    const cookieStore = await cookies();
    const hasSessionCookie = !!cookieStore.get(SESSION_COOKIE)?.value;
    return { serverUrl, authHeader, username, hasSessionCookie };
  }

  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE)?.value;
  if (!token) return null;

  const credentials = decryptSession(token);
  if (!credentials) return null;

  const basic = `Basic ${Buffer.from(`${credentials.username}:${credentials.password}`).toString('base64')}`;
  return { serverUrl: credentials.serverUrl, authHeader: basic, username: credentials.username, hasSessionCookie: true };
}

/**
 * POST /api/account/stalwart/password
 * Change user password via Stalwart PATCH /api/principal/{name}
 *
 * Body: { currentPassword: string, newPassword: string }
 */
export async function POST(request: NextRequest) {
  try {
    const creds = await getCredentials(request);
    if (!creds) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
    }

    const { currentPassword, newPassword } = await request.json();

    if (!currentPassword || !newPassword) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
    }

    if (newPassword.length < 8) {
      return NextResponse.json({ error: 'Password must be at least 8 characters' }, { status: 400 });
    }

    // Verify current password by attempting to authenticate
    const verifyAuth = `Basic ${Buffer.from(`${creds.username}:${currentPassword}`).toString('base64')}`;
    const verifyResponse = await fetch(`${creds.serverUrl}/.well-known/jmap`, {
      method: 'GET',
      headers: { 'Authorization': verifyAuth },
    });

    if (!verifyResponse.ok) {
      return NextResponse.json({ error: 'Current password is incorrect' }, { status: 403 });
    }

    // Change password via Stalwart principal API
    const response = await fetch(`${creds.serverUrl}/api/principal/${encodeURIComponent(creds.username)}`, {
      method: 'PATCH',
      headers: {
        'Authorization': creds.authHeader,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify([
        { action: 'set', field: 'secrets', value: newPassword },
      ]),
    });

    if (!response.ok) {
      const text = await response.text();
      logger.warn('Stalwart password change failed', { status: response.status });
      return NextResponse.json(
        { error: 'Failed to change password', details: text },
        { status: response.status }
      );
    }

    // If session cookie exists, update it with the new password
    if (creds.hasSessionCookie) {
      const newToken = encryptSession(creds.serverUrl, creds.username, newPassword);
      const cookieStore = await cookies();
      cookieStore.set(SESSION_COOKIE, newToken, COOKIE_OPTIONS);
    }

    return NextResponse.json({ ok: true });
  } catch (error) {
    logger.error('Stalwart password change proxy error', { error: error instanceof Error ? error.message : 'Unknown' });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
