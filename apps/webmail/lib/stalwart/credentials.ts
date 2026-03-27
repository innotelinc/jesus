import { cookies } from 'next/headers';
import { NextRequest } from 'next/server';
import { decryptSession } from '@/lib/auth/crypto';
import { SESSION_COOKIE } from '@/lib/auth/session-cookie';

export interface StalwartCredentials {
  /** URL for Stalwart management API calls (uses STALWART_API_URL if set, otherwise serverUrl) */
  apiUrl: string;
  /** URL of the JMAP server (for JMAP operations like password verification) */
  serverUrl: string;
  authHeader: string;
  username: string;
  hasSessionCookie: boolean;
}

/**
 * Resolve the base URL for Stalwart management API requests.
 *
 * When the JMAP server sits behind a reverse proxy that only forwards
 * JMAP paths, the `/api/account/*` and `/api/principal/*` management
 * endpoints may not be exposed.  In that case, operators can set
 * `STALWART_API_URL` to point directly at the Stalwart HTTP listener
 * (e.g. `https://admin.example.com`).
 */
function getStalwartApiUrl(jmapServerUrl: string): string {
  const url = process.env.STALWART_API_URL || jmapServerUrl;
  return url.replace(/\/+$/, '');
}

/**
 * Extract credentials from the incoming request.
 *
 * Tries the explicit headers first (`Authorization`, `X-JMAP-Server-URL`,
 * `X-JMAP-Username`), then falls back to the encrypted session cookie.
 */
export async function getStalwartCredentials(request: NextRequest): Promise<StalwartCredentials | null> {
  const authHeader = request.headers.get('Authorization');
  const serverUrl = request.headers.get('X-JMAP-Server-URL');
  const username = request.headers.get('X-JMAP-Username');

  if (authHeader && serverUrl && username) {
    const cookieStore = await cookies();
    const hasSessionCookie = !!cookieStore.get(SESSION_COOKIE)?.value;
    return {
      apiUrl: getStalwartApiUrl(serverUrl),
      serverUrl,
      authHeader,
      username,
      hasSessionCookie,
    };
  }

  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE)?.value;
  if (!token) return null;

  const credentials = decryptSession(token);
  if (!credentials) return null;

  const basic = `Basic ${Buffer.from(`${credentials.username}:${credentials.password}`).toString('base64')}`;
  return {
    apiUrl: getStalwartApiUrl(credentials.serverUrl),
    serverUrl: credentials.serverUrl,
    authHeader: basic,
    username: credentials.username,
    hasSessionCookie: true,
  };
}
