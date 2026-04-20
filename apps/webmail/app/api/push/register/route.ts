import { NextRequest, NextResponse } from 'next/server';
import { logger } from '@/lib/logger';
import { subscriptionStore } from '@/lib/push/store';
import {
  isValidAuthSecret,
  isValidP256dh,
  isValidPushEndpoint,
  isValidSubscriptionId,
} from '@/lib/push/validation';
import type { SubscriptionRecord } from '@/lib/push/types';

/**
 * POST /api/push/register
 * Body: { subscriptionId, endpoint, p256dh, auth, accountLabel? }
 *
 * Called by the mobile app once its UnifiedPush distributor has produced a
 * push endpoint. We hold only the Web Push keys needed to encrypt payloads
 * per RFC 8291 — no user credentials pass through the relay.
 */
export async function POST(request: NextRequest) {
  try {
    const body = (await request.json().catch(() => null)) as {
      subscriptionId?: unknown;
      endpoint?: unknown;
      p256dh?: unknown;
      auth?: unknown;
      accountLabel?: unknown;
    } | null;
    if (!body) return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });

    const { subscriptionId, endpoint, p256dh, auth, accountLabel } = body;
    if (!isValidSubscriptionId(subscriptionId)) {
      return NextResponse.json({ error: 'Invalid subscriptionId' }, { status: 400 });
    }
    if (!isValidPushEndpoint(endpoint)) {
      return NextResponse.json({ error: 'Invalid endpoint' }, { status: 400 });
    }
    if (!isValidP256dh(p256dh)) {
      return NextResponse.json({ error: 'Invalid p256dh' }, { status: 400 });
    }
    if (!isValidAuthSecret(auth)) {
      return NextResponse.json({ error: 'Invalid auth' }, { status: 400 });
    }

    // Preserve verificationCode if a previous record exists — the JMAP server
    // may have already POSTed PushVerification before the app re-registers.
    const existing = await subscriptionStore.get(subscriptionId);

    const record: SubscriptionRecord = {
      endpoint,
      p256dh,
      auth,
      verificationCode: existing?.verificationCode ?? null,
      createdAt: existing?.createdAt ?? Date.now(),
      lastPushAt: existing?.lastPushAt ?? null,
      accountLabel:
        typeof accountLabel === 'string' ? accountLabel.slice(0, 120) : undefined,
    };
    await subscriptionStore.put(subscriptionId, record);

    return NextResponse.json({ ok: true });
  } catch (error) {
    logger.error('push: register failed', {
      error: error instanceof Error ? error.message : 'Unknown error',
    });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
