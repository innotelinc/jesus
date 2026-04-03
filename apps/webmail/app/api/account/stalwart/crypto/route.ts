import { NextRequest, NextResponse } from 'next/server';
import { logger } from '@/lib/logger';
import { getStalwartCredentials } from '@/lib/stalwart/credentials';

/**
 * Parse Stalwart error response to extract meaningful error message
 */
function parseStalwartError(responseText: string): string {
  try {
    const error = JSON.parse(responseText);
    if (error.detail) return error.detail;
    if (error.error) return error.error;
    return `HTTP ${error.status || 'Error'}`;
  } catch {
    return responseText;
  }
}

/**
 * GET /api/account/stalwart/crypto
 * Proxy to Stalwart GET /api/account/crypto
 */
export async function GET(request: NextRequest) {
  try {
    const creds = await getStalwartCredentials(request);
    if (!creds) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
    }

    const response = await fetch(`${creds.apiUrl}/api/account/crypto`, {
      method: 'GET',
      headers: { 'Authorization': creds.authHeader },
    });

    if (!response.ok) {
      const text = await response.text();
      const detail = parseStalwartError(text);
      logger.warn('Stalwart crypto info failed', { status: response.status, detail });
      return NextResponse.json(
        { error: detail || 'Failed to fetch crypto info' },
        { status: response.status }
      );
    }

    const data = await response.json();
    return NextResponse.json(data);
  } catch (error) {
    logger.error('Stalwart crypto proxy error', { error: error instanceof Error ? error.message : 'Unknown' });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

/**
 * POST /api/account/stalwart/crypto
 * Proxy to Stalwart POST /api/account/crypto
 */
export async function POST(request: NextRequest) {
  try {
    const creds = await getStalwartCredentials(request);
    if (!creds) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
    }

    const body = await request.json();

    const response = await fetch(`${creds.apiUrl}/api/account/crypto`, {
      method: 'POST',
      headers: {
        'Authorization': creds.authHeader,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    const data = await response.json();

    if (!response.ok) {
      logger.warn('Stalwart crypto update failed', { status: response.status });
      return NextResponse.json(data, { status: response.status });
    }

    return NextResponse.json(data);
  } catch (error) {
    logger.error('Stalwart crypto update proxy error', { error: error instanceof Error ? error.message : 'Unknown' });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
