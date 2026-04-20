import { NextRequest, NextResponse } from 'next/server';
import { logger } from '@/lib/logger';
import { subscriptionStore } from '@/lib/push/store';
import { isValidSubscriptionId } from '@/lib/push/validation';

/**
 * GET /api/push/verify/:id
 *
 * Mobile app polls this after creating a JMAP PushSubscription. When the
 * JMAP server POSTs a PushVerification to /api/push/jmap/:id we stash the
 * code on the record; the client then PATCHes the subscription with it and
 * activation completes (RFC 8620 §7.2.2).
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    if (!isValidSubscriptionId(id)) {
      return NextResponse.json({ error: 'Invalid subscriptionId' }, { status: 400 });
    }
    const record = await subscriptionStore.get(id);
    if (!record) {
      return NextResponse.json({ error: 'Unknown subscription' }, { status: 404 });
    }
    return NextResponse.json({ verificationCode: record.verificationCode ?? null });
  } catch (error) {
    logger.error('push: verify poll failed', {
      error: error instanceof Error ? error.message : 'Unknown error',
    });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
