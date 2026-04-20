import { NextRequest, NextResponse } from 'next/server';
import { logger } from '@/lib/logger';
import { subscriptionStore } from '@/lib/push/store';
import {
  isValidExpoPushToken,
  isValidSubscriptionId,
} from '@/lib/push/validation';
import type { SubscriptionRecord } from '@/lib/push/types';

/**
 * POST /api/push/register
 * Body: { subscriptionId, expoPushToken, accountLabel? }
 *
 * Called by the mobile app once it has created a JMAP PushSubscription and
 * received the subscriptionId it plans to use. We hold only the device's
 * Expo push token + that id — no user credentials pass through the relay.
 */
export async function POST(request: NextRequest) {
  try {
    const body = (await request.json().catch(() => null)) as {
      subscriptionId?: unknown;
      expoPushToken?: unknown;
      accountLabel?: unknown;
    } | null;
    if (!body) return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });

    const { subscriptionId, expoPushToken, accountLabel } = body;
    if (!isValidSubscriptionId(subscriptionId)) {
      return NextResponse.json({ error: 'Invalid subscriptionId' }, { status: 400 });
    }
    if (!isValidExpoPushToken(expoPushToken)) {
      return NextResponse.json({ error: 'Invalid expoPushToken' }, { status: 400 });
    }

    const record: SubscriptionRecord = {
      expoPushToken,
      verificationCode: null,
      createdAt: Date.now(),
      lastPushAt: null,
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
