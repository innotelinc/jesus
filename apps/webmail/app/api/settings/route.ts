import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { logger } from '@/lib/logger';
import { decryptSession } from '@/lib/auth/crypto';
import { SESSION_COOKIE } from '@/lib/auth/session-cookie';
import { saveUserSettings, loadUserSettings, deleteUserSettings } from '@/lib/settings-sync';

function isEnabled(): boolean {
  return process.env.SETTINGS_SYNC_ENABLED === 'true' && !!process.env.SESSION_SECRET;
}

/**
 * Verify identity against the session cookie if available.
 * Returns true if no session cookie exists (can't verify) or if identity matches.
 * Returns false if session cookie exists but identity doesn't match.
 */
async function verifyIdentity(username: string, serverUrl: string): Promise<boolean> {
  const cookieStore = await cookies();
  const sessionToken = cookieStore.get(SESSION_COOKIE)?.value;
  if (!sessionToken) return true; // No session cookie, can't verify (same-origin protection applies)

  const session = decryptSession(sessionToken);
  if (!session) return true; // Invalid session cookie, skip verification

  return session.username === username && session.serverUrl === serverUrl;
}

export async function GET(request: NextRequest) {
  if (!isEnabled()) {
    return NextResponse.json({ error: 'Settings sync is disabled' }, { status: 404 });
  }

  const username = request.headers.get('x-settings-username');
  const serverUrl = request.headers.get('x-settings-server');
  if (!username || !serverUrl) {
    return NextResponse.json({ error: 'Missing identity headers' }, { status: 400 });
  }

  if (!(await verifyIdentity(username, serverUrl))) {
    return NextResponse.json({ error: 'Identity mismatch' }, { status: 403 });
  }

  try {
    const settings = await loadUserSettings(username, serverUrl);
    if (!settings) {
      return NextResponse.json({ error: 'No settings found' }, { status: 404 });
    }
    return NextResponse.json({ settings });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    const code = (error as NodeJS.ErrnoException).code;
    logger.error('Settings load error', { error: message, code });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  if (!isEnabled()) {
    return NextResponse.json({ error: 'Settings sync is disabled' }, { status: 404 });
  }

  try {
    const { username, serverUrl, settings } = await request.json();
    if (!username || !serverUrl || !settings) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
    }

    if (typeof settings !== 'object' || settings === null || Array.isArray(settings)) {
      return NextResponse.json({ error: 'Settings must be an object' }, { status: 400 });
    }

    if (!(await verifyIdentity(username, serverUrl))) {
      return NextResponse.json({ error: 'Identity mismatch' }, { status: 403 });
    }

    await saveUserSettings(username, serverUrl, settings);
    return NextResponse.json({ ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    const code = (error as NodeJS.ErrnoException).code;
    logger.error('Settings save error', { error: message, code });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  if (!isEnabled()) {
    return NextResponse.json({ error: 'Settings sync is disabled' }, { status: 404 });
  }

  try {
    const { username, serverUrl } = await request.json();
    if (!username || !serverUrl) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
    }

    if (!(await verifyIdentity(username, serverUrl))) {
      return NextResponse.json({ error: 'Identity mismatch' }, { status: 403 });
    }

    await deleteUserSettings(username, serverUrl);
    return NextResponse.json({ ok: true });
  } catch (error) {
    logger.error('Settings delete error', { error: error instanceof Error ? error.message : 'Unknown error' });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
