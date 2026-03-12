import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { logger } from '@/lib/logger';
import { decryptSession } from '@/lib/auth/crypto';
import { SESSION_COOKIE } from '@/lib/auth/session-cookie';

async function getCredentials(request: NextRequest): Promise<{ serverUrl: string; authHeader: string } | null> {
  const authHeader = request.headers.get('Authorization');
  const serverUrl = request.headers.get('X-JMAP-Server-URL');

  if (authHeader && serverUrl) {
    return { serverUrl, authHeader };
  }

  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE)?.value;
  if (!token) return null;

  const credentials = decryptSession(token);
  if (!credentials) return null;

  const basic = `Basic ${Buffer.from(`${credentials.username}:${credentials.password}`).toString('base64')}`;
  return { serverUrl: credentials.serverUrl, authHeader: basic };
}

/**
 * GET /api/account/stalwart/probe
 * Detect whether the JMAP server is Stalwart by probing /api/account/auth
 */
export async function GET(request: NextRequest) {
  try {
    const creds = await getCredentials(request);
    if (!creds) {
      return NextResponse.json({ isStalwart: false });
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    try {
      const response = await fetch(`${creds.serverUrl}/api/account/auth`, {
        method: 'GET',
        headers: { 'Authorization': creds.authHeader },
        signal: controller.signal,
      });

      clearTimeout(timeout);

      if (!response.ok) {
        return NextResponse.json({ isStalwart: false });
      }

      const data = await response.json();
      const isStalwart = data.data !== undefined && typeof data.data.otpEnabled === 'boolean';

      return NextResponse.json({ isStalwart });
    } catch {
      clearTimeout(timeout);
      return NextResponse.json({ isStalwart: false });
    }
  } catch (error) {
    logger.error('Stalwart probe error', { error: error instanceof Error ? error.message : 'Unknown' });
    return NextResponse.json({ isStalwart: false });
  }
}
