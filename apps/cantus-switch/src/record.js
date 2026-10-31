/**
 * Sealed records: media that a relay can carry without being able to read it.
 *
 * §9.6 says a relay forwards a call it cannot understand, and §4.4 said that was
 * impossible on the encrypted binding because a relay terminates TCP and the
 * relay path is cleartext. §9.7 closes that hole: the media inside a `RECORD`
 * datagram is an AEAD envelope sealed between the two endpoints, keyed from an
 * X25519 exchange carried in `INVITE`/`ACCEPT`, so the relay only ever moves
 * octets. It cannot read them, alter them undetected, or replay them.
 *
 * The key is per call, not per node: `HKDF-SHA256(X25519(a, B), SHA-256(CallId),
 * "cantus/1-record")`. Two calls between the same pair share nothing, and a
 * relay that saw both could not use one to open the other.
 */

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
} from 'node:crypto';

export const RECORD_INFO = 'cantus/1-record';
export const TAG_OCTETS = 16;
export const NONCE_OCTETS = 12;

/** An X25519 key pair, public half as 32 raw octets. */
export function newKeyPair() {
  const { publicKey, privateKey } = generateKeyPairSync('x25519');
  return {
    publicKey: rawPublicKey(publicKey),
    privateKey: privateKey.export({ type: 'pkcs8', format: 'der' }),
  };
}

/** The 32-octet u-coordinate of an X25519 public key. */
export function rawPublicKey(publicKey) {
  const jwk = (publicKey.export ? publicKey : createPublicKey(publicKey)).export({ format: 'jwk' });
  return Buffer.from(jwk.x, 'base64url');
}

function publicKeyFromRaw(raw) {
  if (!raw || raw.length !== 32) throw new Error('cantus/record: a public key is 32 octets');
  return createPublicKey({
    key: { kty: 'OKP', crv: 'X25519', x: Buffer.from(raw).toString('base64url') },
    format: 'jwk',
  });
}

/**
 * The per-call sealing key.
 *
 * Both ends compute the same octets without any of them being sent: `privateKey`
 * is ours, `peerRaw` came in the other side's `kex` field. `call` is the CallId,
 * which both sides already know, so it costs no signalling and makes a key
 * useless outside the call it was made for.
 */
export function deriveKey({ privateKey, peerRaw, call }) {
  const shared = diffieHellman({
    privateKey: createPrivateKey({ key: privateKey, format: 'der', type: 'pkcs8' }),
    publicKey: publicKeyFromRaw(peerRaw),
  });
  const salt = createHash('sha256').update(String(call), 'utf8').digest();
  return Buffer.from(hkdfSync('sha256', shared, salt, RECORD_INFO, 32));
}

function nonceFor(seq) {
  const nonce = Buffer.alloc(NONCE_OCTETS);
  nonce.writeBigUInt64BE(BigInt(seq), NONCE_OCTETS - 8);
  return nonce;
}

function additionalData(tag, seq) {
  const aad = Buffer.alloc(10);
  aad.writeUInt16BE(tag & 0xffff, 0);
  aad.writeBigUInt64BE(BigInt(seq), 2);
  return aad;
}

/**
 * Seal one inner datagram. `seq` is the replay counter: it is inside the AEAD
 * as additional data, so it cannot be rewritten in flight, and the receiver
 * rejects anything not strictly newer than the last record it opened.
 */
export function seal({ key, tag, seq, payload }) {
  if (!Buffer.isBuffer(key) || key.length !== 32) throw new Error('cantus/record: key must be 32 octets');
  const cipher = createCipheriv('aes-256-gcm', key, nonceFor(seq));
  cipher.setAAD(additionalData(tag, seq));
  const body = Buffer.concat([cipher.update(payload), cipher.final()]);
  const header = Buffer.alloc(8);
  header.writeBigUInt64BE(BigInt(seq), 0);
  return { seq, record: Buffer.concat([header, body, cipher.getAuthTag()]) };
}

/** The sequence number a sealed record announces. Untrusted until `open`. */
export function seqOf(record) {
  if (!Buffer.isBuffer(record) || record.length < 8 + TAG_OCTETS) throw new Error('cantus/record: short record');
  return Number(record.readBigUInt64BE(0));
}

/** Open a sealed record, or throw. There is no partial success and no fallback. */
export function open({ key, tag, record }) {
  if (!Buffer.isBuffer(record) || record.length < 8 + TAG_OCTETS) throw new Error('cantus/record: short record');
  const seq = Number(record.readBigUInt64BE(0));
  const tagOctets = record.subarray(record.length - TAG_OCTETS);
  const body = record.subarray(8, record.length - TAG_OCTETS);
  const decipher = createDecipheriv('aes-256-gcm', key, nonceFor(seq));
  decipher.setAAD(additionalData(tag, seq));
  decipher.setAuthTag(tagOctets);
  return { seq, payload: Buffer.concat([decipher.update(body), decipher.final()]) };
}
