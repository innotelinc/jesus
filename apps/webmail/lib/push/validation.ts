export function isValidSubscriptionId(id: unknown): id is string {
  return typeof id === 'string' && /^[A-Za-z0-9_-]{8,128}$/.test(id);
}

export function isValidExpoPushToken(token: unknown): token is string {
  if (typeof token !== 'string') return false;
  // Expo managed tokens, or raw FCM/APNs tokens for bare workflows.
  return (
    /^ExponentPushToken\[[A-Za-z0-9_-]+\]$/.test(token) ||
    /^[A-Za-z0-9:_-]{40,250}$/.test(token)
  );
}
