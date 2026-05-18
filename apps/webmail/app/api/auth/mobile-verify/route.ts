import { NextRequest, NextResponse } from 'next/server';
import { logger } from '@/lib/logger';
import {
  JmapAuthVerificationError,
  verifyJmapAuth,
} from '@/lib/auth/verify-jmap-auth';
import { configManager } from '@/lib/admin/config-manager';
import { parseJmapServers, resolveTrustedJmapUrl } from '@/lib/admin/jmap-servers';

// Verifies a JMAP credential pair against the user-supplied server URL on
// behalf of the mobile handoff page. We deliberately do NOT set any session
// cookies here — the credentials are about to be handed back to the mobile
// app, which manages its own per-account credential storage.
export async function POST(request: NextRequest) {
  try {
    const { serverUrl, username, password } = await request.json();
    if (!serverUrl || !username || !password) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
    }

    await configManager.ensureLoaded();
    const configuredServerUrl =
      configManager.get<string>('jmapServerUrl', '') ||
      process.env.JMAP_SERVER_URL ||
      process.env.NEXT_PUBLIC_JMAP_SERVER_URL ||
      '';
    const allowCustomEndpoint = configManager.get<boolean>('allowCustomJmapEndpoint', false);
    const serverList = parseJmapServers(configManager.get<unknown>('jmapServers', []));
    const trustedUrl = resolveTrustedJmapUrl(serverUrl, configuredServerUrl, serverList);

    let upstreamUrl: string;
    let upstreamTrusted: boolean;
    if (trustedUrl) {
      upstreamUrl = trustedUrl;
      upstreamTrusted = true;
    } else if (allowCustomEndpoint) {
      upstreamUrl = serverUrl;
      upstreamTrusted = false;
    } else {
      return NextResponse.json({ error: 'JMAP server not configured' }, { status: 500 });
    }

    const authHeader = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
    const normalizedServerUrl = await verifyJmapAuth(upstreamUrl, authHeader, {
      trusted: upstreamTrusted,
    });

    return NextResponse.json({ ok: true, serverUrl: normalizedServerUrl });
  } catch (error) {
    if (error instanceof JmapAuthVerificationError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    logger.error('Mobile verify error', { error: error instanceof Error ? error.message : 'Unknown error' });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
