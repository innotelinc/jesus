import crypto from 'node:crypto';
import { b64uDecode, b64uEncode } from './base64url';
import type { VapidKeys } from './vapid';

// RFC 5869 HKDF-Extract + HKDF-Expand using SHA-256.
function hkdf(salt: Buffer, ikm: Buffer, info: Buffer, length: number): Buffer {
  const prk = crypto.createHmac('sha256', salt).update(ikm).digest();
  const out = Buffer.alloc(length);
  let previous = Buffer.alloc(0);
  let offset = 0;
  let counter = 1;
  while (offset < length) {
    const hmac = crypto.createHmac('sha256', prk);
    hmac.update(previous);
    hmac.update(info);
    hmac.update(Buffer.from([counter]));
    previous = hmac.digest();
    const copyLen = Math.min(previous.length, length - offset);
    previous.subarray(0, copyLen).copy(out, offset);
    offset += copyLen;
    counter++;
  }
  return out;
}

// RFC 8291 aes128gcm Web Push content encoding (single record).
export function encryptAes128gcm(params: {
  p256dh: Buffer;
  auth: Buffer;
  payload: Buffer;
}): Buffer {
  const ecdh = crypto.createECDH('prime256v1');
  const serverPublic = ecdh.generateKeys();
  const sharedSecret = ecdh.computeSecret(params.p256dh);
  const salt = crypto.randomBytes(16);

  // RFC 8291 §3.3: PRK_key = HMAC-SHA-256(auth_secret, IKM)
  //                IKM = ECDH shared secret
  //                info = "WebPush: info\0" || ua_public || as_public
  const keyInfo = Buffer.concat([
    Buffer.from('WebPush: info\0', 'utf-8'),
    params.p256dh,
    serverPublic,
  ]);
  const prkKey = hkdf(params.auth, sharedSecret, keyInfo, 32);

  // RFC 8188 §2.2: derive CEK and nonce from PRK_key with salt.
  const cek = hkdf(salt, prkKey, Buffer.from('Content-Encoding: aes128gcm\0', 'utf-8'), 16);
  const nonce = hkdf(salt, prkKey, Buffer.from('Content-Encoding: nonce\0', 'utf-8'), 12);

  // Single-record padding: plaintext || 0x02 (end-of-last-record delimiter).
  const padded = Buffer.concat([params.payload, Buffer.from([0x02])]);

  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const ciphertext = Buffer.concat([cipher.update(padded), cipher.final()]);
  const tag = cipher.getAuthTag();

  // Per RFC 8188 §2.1: salt (16) || rs (4 BE) || idlen (1) || keyid || ciphertext+tag.
  const rsBuf = Buffer.alloc(4);
  rsBuf.writeUInt32BE(4096, 0);
  const idlenBuf = Buffer.from([serverPublic.length]);

  return Buffer.concat([salt, rsBuf, idlenBuf, serverPublic, ciphertext, tag]);
}

// ECDSA DER → raw r||s (64 bytes) for ES256 signature encoding used by JWT.
function derEs256ToRaw(der: Buffer): Buffer {
  if (der[0] !== 0x30) throw new Error('Invalid DER signature');
  let offset = 2;
  if (der[1] & 0x80) offset += der[1] & 0x7f;
  if (der[offset] !== 0x02) throw new Error('Invalid DER r marker');
  const rLen = der[offset + 1];
  let r = der.subarray(offset + 2, offset + 2 + rLen);
  offset += 2 + rLen;
  if (der[offset] !== 0x02) throw new Error('Invalid DER s marker');
  const sLen = der[offset + 1];
  let s = der.subarray(offset + 2, offset + 2 + sLen);
  const pad = (buf: Buffer) => {
    if (buf.length === 32) return buf;
    if (buf.length === 33 && buf[0] === 0x00) return buf.subarray(1);
    if (buf.length > 32) throw new Error('ECDSA component > 32 bytes');
    const out = Buffer.alloc(32);
    buf.copy(out, 32 - buf.length);
    return out;
  };
  return Buffer.concat([pad(r), pad(s)]);
}

function buildVapidJwt(endpoint: string, vapid: VapidKeys): string {
  const audience = new URL(endpoint).origin;
  const header = b64uEncode(Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64uEncode(
    Buffer.from(
      JSON.stringify({
        aud: audience,
        exp: Math.floor(Date.now() / 1000) + 12 * 3600,
        sub: vapid.subject,
      }),
    ),
  );
  const signingInput = `${header}.${claims}`;
  const der = crypto.createSign('SHA256').update(signingInput).sign(vapid.privateKeyPem);
  return `${signingInput}.${b64uEncode(derEs256ToRaw(der))}`;
}

export interface WebPushResult {
  ok: boolean;
  status: number;
  body?: string;
}

export async function sendWebPush(params: {
  endpoint: string;
  p256dh: string;
  auth: string;
  payload: Buffer;
  vapid: VapidKeys;
  ttlSeconds?: number;
  urgency?: 'very-low' | 'low' | 'normal' | 'high';
  topic?: string;
}): Promise<WebPushResult> {
  const body = encryptAes128gcm({
    p256dh: b64uDecode(params.p256dh),
    auth: b64uDecode(params.auth),
    payload: params.payload,
  });
  const jwt = buildVapidJwt(params.endpoint, params.vapid);
  const headers: Record<string, string> = {
    'content-type': 'application/octet-stream',
    'content-encoding': 'aes128gcm',
    'content-length': String(body.length),
    ttl: String(params.ttlSeconds ?? 60),
    urgency: params.urgency ?? 'high',
    authorization: `vapid t=${jwt}, k=${params.vapid.publicKey}`,
  };
  if (params.topic) headers.topic = params.topic;

  const res = await fetch(params.endpoint, {
    method: 'POST',
    headers,
    body: new Uint8Array(body),
  });
  const ok = res.status >= 200 && res.status < 300;
  return {
    ok,
    status: res.status,
    body: ok ? undefined : await res.text().catch(() => undefined),
  };
}
