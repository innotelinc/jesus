import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { logger } from '@/lib/logger';
import { decryptSession } from '@/lib/auth/crypto';
import { SESSION_COOKIE } from '@/lib/auth/session-cookie';

/**
 * Extract the user's JMAP server URL and auth header from the session cookie
 * or from the Authorization header passed by the client.
 */
async function getCredentials(request: NextRequest): Promise<{ serverUrl: string; authHeader: string; username: string } | null> {
  // Try Authorization header first (for bearer/basic auth forwarding)
  const authHeader = request.headers.get('Authorization');
  const serverUrl = request.headers.get('X-JMAP-Server-URL');
  const username = request.headers.get('X-JMAP-Username');

  if (authHeader && serverUrl && username) {
    return { serverUrl, authHeader, username };
  }

  // Fall back to session cookie
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE)?.value;
  if (!token) return null;

  const credentials = decryptSession(token);
  if (!credentials) return null;

  const basic = `Basic ${Buffer.from(`${credentials.username}:${credentials.password}`).toString('base64')}`;
  return { serverUrl: credentials.serverUrl, authHeader: basic, username: credentials.username };
}

/**
 * GET /api/account/stalwart/auth
 * Proxy to Stalwart GET /api/account/auth
 */
export async function GET(request: NextRequest) {
  try {
    const creds = await getCredentials(request);
    if (!creds) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
    }

    const response = await fetch(`${creds.serverUrl}/api/account/auth`, {
      method: 'GET',
      headers: { 'Authorization': creds.authHeader },
    });

    if (!response.ok) {
      const text = await response.text();
      logger.warn('Stalwart auth info failed', { status: response.status });
      return NextResponse.json(
        { error: 'Failed to fetch auth info', details: text },
        { status: response.status }
      );
    }

    const data = await response.json();
    return NextResponse.json(data);
  } catch (error) {
    logger.error('Stalwart auth proxy error', { error: error instanceof Error ? error.message : 'Unknown' });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

/**
 * POST /api/account/stalwart/auth
 * Proxy to Stalwart POST /api/account/auth
 */
export async function POST(request: NextRequest) {
  try {
    const creds = await getCredentials(request);
    if (!creds) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
    }

    const body = await request.json();

    const response = await fetch(`${creds.serverUrl}/api/account/auth`, {
      method: 'POST',
      headers: {
        'Authorization': creds.authHeader,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    const data = await response.json();

    if (!response.ok) {
      logger.warn('Stalwart auth update failed', { status: response.status });
      return NextResponse.json(data, { status: response.status });
    }

    return NextResponse.json(data);
  } catch (error) {
    logger.error('Stalwart auth update proxy error', { error: error instanceof Error ? error.message : 'Unknown' });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
