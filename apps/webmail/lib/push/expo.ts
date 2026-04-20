import { logger } from '@/lib/logger';
import type { StateChange, SubscriptionRecord } from './types';

// Expo's push API. Swap via env when self-hosting.
function getExpoPushUrl(): string {
  return process.env.EXPO_PUSH_URL ?? 'https://exp.host/--/api/v2/push/send';
}

export async function sendExpoPush(
  record: SubscriptionRecord,
  change: StateChange,
): Promise<boolean> {
  // Summarize the JMAP StateChange into a hint the user can see on lock
  // screen. The app wakes on receipt, re-fetches via JMAP with its own creds,
  // and can replace the notification via `presentNotificationAsync` if
  // subject/sender should be shown.
  const types = new Set<string>();
  for (const perAccount of Object.values(change.changed)) {
    for (const type of Object.keys(perAccount)) types.add(type);
  }
  const hasEmail = types.has('Email') || types.has('EmailDelivery');

  const message = {
    to: record.expoPushToken,
    title: hasEmail ? 'New mail' : 'Mailbox updated',
    body: record.accountLabel ?? '',
    sound: 'default',
    priority: 'high' as const,
    channelId: 'mail',
    data: {
      kind: 'jmap-state-change',
      changed: change.changed,
    },
    _contentAvailable: true,
  };

  try {
    const res = await fetch(getExpoPushUrl(), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        'accept-encoding': 'gzip, deflate',
      },
      body: JSON.stringify(message),
    });
    if (!res.ok) {
      logger.warn('push: expo delivery failed', {
        status: res.status,
        body: await res.text().catch(() => ''),
      });
      return false;
    }
    return true;
  } catch (error) {
    logger.warn('push: expo delivery error', {
      error: error instanceof Error ? error.message : 'Unknown error',
    });
    return false;
  }
}
