import { createHmac, createHash, randomBytes, randomInt, scryptSync, timingSafeEqual } from 'node:crypto';
import { config } from '../config.js';

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 };

export function hashPassword(password) {
  if (typeof password !== 'string' || password.length < 10) {
    throw new Error('Password must be at least 10 characters');
  }
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(password.normalize('NFKC'), salt, SCRYPT.keylen, SCRYPT).toString('hex');
  return `scrypt$${SCRYPT.N}$${salt}$${hash}`;
}

export function verifyPassword(password, stored) {
  try {
    const [kind, n, salt, hash] = String(stored || '').split('$');
    if (kind !== 'scrypt') return false;
    const expected = Buffer.from(hash, 'hex');
    const actual = scryptSync(String(password).normalize('NFKC'), salt, expected.length, {
      N: Number(n),
      r: SCRYPT.r,
      p: SCRYPT.p,
    });
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

const b64url = (buf) => Buffer.from(buf).toString('base64url');
const hmac = (data) => createHmac('sha256', config.sessionSecret).update(data).digest();

/** Compact signed session token (header-free: payload is authenticated by HMAC). */
export function signSession(payload, days = config.sessionDays) {
  const now = Math.floor(Date.now() / 1000);
  const body = { ...payload, iat: now, exp: now + days * 86400 };
  const encoded = b64url(JSON.stringify(body));
  return `${encoded}.${b64url(hmac(encoded))}`;
}

export function verifySession(token) {
  if (typeof token !== 'string' || !token.includes('.')) return null;
  const [encoded, signature] = token.split('.');
  const expected = hmac(encoded);
  let provided;
  try {
    provided = Buffer.from(signature, 'base64url');
  } catch {
    return null;
  }
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) return null;
  try {
    const body = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    if (!body.exp || body.exp < Math.floor(Date.now() / 1000)) return null;
    return body;
  } catch {
    return null;
  }
}

export const sha256Hex = (value) => createHash('sha256').update(String(value)).digest('hex');

/** Pseudonymize an IP so rate-limit and abuse records stay non-identifying. */
export const hashIp = (ip) => sha256Hex(`ip:${config.apiKeyPepper}:${ip || ''}`).slice(0, 32);

export function newApiKey() {
  const secret = `tl_${randomBytes(24).toString('base64url')}`;
  return { secret, prefix: secret.slice(0, 11), hash: sha256Hex(`key:${config.apiKeyPepper}:${secret}`) };
}

export const apiKeyHash = (secret) => sha256Hex(`key:${config.apiKeyPepper}:${secret}`);

/** A device's own credential for check-ins; only its hash is ever stored. */
export function newDeviceToken() {
  const secret = `dv_${randomBytes(24).toString('base64url')}`;
  return { secret, prefix: secret.slice(0, 8), hash: deviceTokenHash(secret) };
}

export const deviceTokenHash = (secret) => sha256Hex(`device:${config.apiKeyPepper}:${secret}`);

/** Six-digit numeric code, uniformly distributed. */
export function newOtpCode() {
  // crypto.randomInt avoids the modulo bias of % 1000000.
  return String(randomInt(0, 1_000_000)).padStart(6, '0');
}

export const otpHash = (code, submissionId) =>
  sha256Hex(`otp:${config.apiKeyPepper}:${submissionId}:${code}`);
