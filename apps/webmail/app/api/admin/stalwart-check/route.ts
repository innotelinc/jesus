import { NextRequest, NextResponse } from 'next/server';
import { logger } from '@/lib/logger';
import { getStalwartCredentials } from '@/lib/stalwart/credentials';

/**
 * GET /api/admin/stalwart-check
 * Check if the currently logged-in user has the 'admin' role in Stalwart.
 * Uses the user's JMAP session credentials.
 */
export async function GET(request: NextRequest) {
  try {
    const creds = await getStalwartCredentials(request);
    if (!creds) {
      return NextResponse.json({ isStalwartAdmin: false }, {
        headers: { 'Cache-Control': 'no-store' },
      });
    }

    const response = await fetch(
      `${creds.apiUrl}/api/principal/${encodeURIComponent(creds.username)}`,
      {
        method: 'GET',
        headers: { 'Authorization': creds.authHeader },
      }
    );

    if (!response.ok) {
      return NextResponse.json({ isStalwartAdmin: false }, {
        headers: { 'Cache-Control': 'no-store' },
      });
    }

    const data = await response.json();
    const principal = data.data ?? data;
    const roles: string[] = Array.isArray(principal?.roles) ? principal.roles : [];
    const isStalwartAdmin = roles.includes('admin');

    return NextResponse.json({ isStalwartAdmin }, {
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (error) {
    logger.error('Stalwart admin check error', {
      error: error instanceof Error ? error.message : 'Unknown',
    });
    return NextResponse.json({ isStalwartAdmin: false }, {
      headers: { 'Cache-Control': 'no-store' },
    });
  }
}
