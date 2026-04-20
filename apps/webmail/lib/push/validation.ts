export function isValidSubscriptionId(id: unknown): id is string {
  return typeof id === 'string' && /^[A-Za-z0-9_-]{8,128}$/.test(id);
}

export function isValidPushEndpoint(url: unknown): url is string {
  if (typeof url !== 'string' || url.length > 2048) return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:';
  } catch {
    return false;
  }
}

export function isBase64Url(value: unknown, minBytes: number, maxBytes: number): value is string {
  if (typeof value !== 'string') return false;
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return false;
  // base64url decoded length: floor(n * 3 / 4) where n is input length (no padding).
  const decodedLen = Math.floor((value.length * 3) / 4);
  return decodedLen >= minBytes && decodedLen <= maxBytes;
}

export function isValidP256dh(value: unknown): value is string {
  // Uncompressed P-256 point is 65 bytes (0x04 || X || Y). base64url no padding.
  return isBase64Url(value, 64, 66);
}

export function isValidAuthSecret(value: unknown): value is string {
  // RFC 8291 requires 16 bytes.
  return isBase64Url(value, 16, 16);
}
