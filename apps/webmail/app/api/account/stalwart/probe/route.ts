import { NextRequest, NextResponse } from 'next/server';
import { logger } from '@/lib/logger';
import { getStalwartCredentials } from '@/lib/stalwart/credentials';

/**
 * GET /api/account/stalwart/probe
 * Detect whether the JMAP server is Stalwart by probing /api/account/auth
 */
export async function GET(request: NextRequest) {
  try {
    const creds = await getStalwartCredentials(request);
    if (!creds) {
      return NextResponse.json({ isStalwart: false });
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    try {
      const response = await fetch(`${creds.apiUrl}/api/account/auth`, {
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
