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
 * GET /api/account/stalwart/principal
 * Proxy to Stalwart GET /api/principal/{username}
 */
export async function GET(request: NextRequest) {
  try {
    const creds = await getStalwartCredentials(request);
    if (!creds) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
    }

    const response = await fetch(`${creds.apiUrl}/api/principal/${encodeURIComponent(creds.username)}`, {
      method: 'GET',
      headers: { 'Authorization': creds.authHeader },
    });

    if (!response.ok) {
      const text = await response.text();
      const detail = parseStalwartError(text);
      logger.warn('Stalwart principal fetch failed', { status: response.status, detail });
      return NextResponse.json(
        { error: detail || 'Failed to fetch principal' },
        { status: response.status }
      );
    }

    const data = await response.json();
    return NextResponse.json(data);
  } catch (error) {
    logger.error('Stalwart principal proxy error', { error: error instanceof Error ? error.message : 'Unknown' });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

/**
 * PATCH /api/account/stalwart/principal
 * Proxy to Stalwart PATCH /api/principal/{username}
 * Body: PrincipalUpdateAction[] (array of {action, field, value})
 */
export async function PATCH(request: NextRequest) {
  try {
    const creds = await getStalwartCredentials(request);
    if (!creds) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
    }

    const body = await request.json();

    // Prevent secrets field from being changed through this endpoint (use /password instead)
    if (Array.isArray(body)) {
      const hasSecrets = body.some((action: { field?: string }) => action.field === 'secrets');
      if (hasSecrets) {
        return NextResponse.json({ error: 'Use /api/account/stalwart/password to change passwords' }, { status: 400 });
      }
    }

    const response = await fetch(`${creds.apiUrl}/api/principal/${encodeURIComponent(creds.username)}`, {
      method: 'PATCH',
      headers: {
        'Authorization': creds.authHeader,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    const data = await response.json();

    if (!response.ok) {
      logger.warn('Stalwart principal update failed', { status: response.status });
      return NextResponse.json(data, { status: response.status });
    }

    return NextResponse.json(data);
  } catch (error) {
    logger.error('Stalwart principal update proxy error', { error: error instanceof Error ? error.message : 'Unknown' });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
