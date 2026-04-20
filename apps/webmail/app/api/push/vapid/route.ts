import { NextResponse } from 'next/server';
import { logger } from '@/lib/logger';
import { getVapidKeys } from '@/lib/push/vapid';

/**
 * GET /api/push/vapid
 *
 * Returns the relay's VAPID public key. The mobile app passes this to the
 * UnifiedPush distributor so the distributor can lock the endpoint to pushes
 * signed by us. Generated on first call; persisted under `data/push/vapid.json`.
 */
export async function GET() {
  try {
    const keys = await getVapidKeys();
    return NextResponse.json({ publicKey: keys.publicKey });
  } catch (error) {
    logger.error('push: vapid key fetch failed', {
      error: error instanceof Error ? error.message : 'Unknown error',
    });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
