// Types shared between the relay routes and the store. Kept in a leaf module
// so both server code and admin UIs can import without pulling `node:fs`.

export interface SubscriptionRecord {
  // UnifiedPush / Web Push endpoint the distributor gave the app. The relay
  // POSTs RFC 8291 aes128gcm-encrypted bodies here.
  endpoint: string;
  // P-256 public key (UA), uncompressed 65-byte point, base64url without padding.
  p256dh: string;
  // Auth secret, 16 bytes, base64url without padding.
  auth: string;
  verificationCode: string | null;
  createdAt: number;
  lastPushAt: number | null;
  accountLabel?: string;
}

export interface PushVerification {
  '@type': 'PushVerification';
  pushSubscriptionId: string;
  verificationCode: string;
}

export interface StateChange {
  '@type': 'StateChange';
  changed: Record<string, Record<string, string>>;
}

export type JmapPushBody = PushVerification | StateChange;
