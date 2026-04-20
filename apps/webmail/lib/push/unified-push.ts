import { logger } from '@/lib/logger';
import type { StateChange, SubscriptionRecord } from './types';
import { sendWebPush } from './web-push';
import { getVapidKeys } from './vapid';

interface UnifiedPushPayload {
  kind: 'jmap-state-change';
  title: string;
  body: string;
  changed: Record<string, Record<string, string>>;
}

function buildPayload(record: SubscriptionRecord, change: StateChange): UnifiedPushPayload {
  const types = new Set<string>();
  for (const perAccount of Object.values(change.changed)) {
    for (const type of Object.keys(perAccount)) types.add(type);
  }
  const hasEmail = types.has('Email') || types.has('EmailDelivery');
  return {
    kind: 'jmap-state-change',
    title: hasEmail ? 'New mail' : 'Mailbox updated',
    body: record.accountLabel ?? '',
    changed: change.changed,
  };
}

export async function sendUnifiedPush(
  record: SubscriptionRecord,
  change: StateChange,
): Promise<boolean> {
  try {
    const vapid = await getVapidKeys();
    const payload = Buffer.from(JSON.stringify(buildPayload(record, change)), 'utf-8');
    const result = await sendWebPush({
      endpoint: record.endpoint,
      p256dh: record.p256dh,
      auth: record.auth,
      payload,
      vapid,
      ttlSeconds: 60,
      urgency: 'high',
    });
    if (!result.ok) {
      logger.warn('push: unified-push delivery failed', {
        status: result.status,
        body: result.body,
      });
      return false;
    }
    return true;
  } catch (error) {
    logger.warn('push: unified-push delivery error', {
      error: error instanceof Error ? error.message : 'Unknown error',
    });
    return false;
  }
}
