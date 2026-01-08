import { NextResponse } from 'next/server';

/**
 * Runtime configuration endpoint
 *
 * This endpoint serves configuration values that can be set at runtime
 * via environment variables, enabling post-build configuration for
 * Docker deployments.
 *
 * Priority order:
 * 1. Runtime env vars (APP_NAME, JMAP_SERVER_URL)
 * 2. Build-time env vars (NEXT_PUBLIC_APP_NAME, NEXT_PUBLIC_JMAP_SERVER_URL)
 * 3. Default values
 */
export async function GET() {
  return NextResponse.json({
    appName: process.env.APP_NAME || process.env.NEXT_PUBLIC_APP_NAME || 'Webmail',
    jmapServerUrl: process.env.JMAP_SERVER_URL || process.env.NEXT_PUBLIC_JMAP_SERVER_URL || '',
  });
}
