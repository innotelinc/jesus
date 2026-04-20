import { NextRequest, NextResponse } from 'next/server';
import { logger } from '@/lib/logger';
import { subscriptionStore } from '@/lib/push/store';
import { isValidSubscriptionId } from '@/lib/push/validation';

/**
 * DELETE /api/push/register/:id
 *
 * Client tears down its relay mapping on logout / uninstall. Idempotent —
 * deleting a non-existent id still returns ok.
 */
export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    if (!isValidSubscriptionId(id)) {
      return NextResponse.json({ error: 'Invalid subscriptionId' }, { status: 400 });
    }
    await subscriptionStore.delete(id);
    return NextResponse.json({ ok: true });
  } catch (error) {
    logger.error('push: unregister failed', {
      error: error instanceof Error ? error.message : 'Unknown error',
    });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
