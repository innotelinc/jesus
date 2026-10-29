/**
 * SDES-SRTP for the carrier leg: AES_CM_128_HMAC_SHA1_80, and nothing else.
 *
 * VoIP.ms refused this gateway twice for the same reason — an offer with
 * `m=audio ... RTP/AVP 0` and no `a=crypto` — because an encrypted sub-account
 * only accepts `RTP/SAVP` with a key in the SDP. This file is that key.
 *
 * SDES is the simple half of SRTP: the key travels in the signalling, in
 * `a=crypto:<tag> AES_CM_128_HMAC_SHA1_80 inline:<base64 of key||salt>`, so
 * there is no DTLS handshake and no certificate. What it shares with every
 * SRTP profile is RFC 3711's packet protection: a session key derived from the
 * master key, AES in counter mode over the payload, and an HMAC-SHA1 over the
 * packet that is truncated to 80 bits.
 *
 * Only the payload is encrypted — RTP headers stay readable, which is what lets
 * the far side route and sequence the packet before it can decrypt anything.
 */

import { createCipheriv, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const PROFILE = 'AES_CM_128_HMAC_SHA1_80';
export const MASTER_KEY_BYTES = 16;
export const MASTER_SALT_BYTES = 14;
export const TAG_BYTES = 10; // 80 bits of HMAC-SHA1

const LABEL_ENCRYPTION_KEY = 0x00;
const LABEL_AUTH_KEY = 0x01;
const LABEL_SALT = 0x02;

/** AES-CM keystream, which is how RFC 3711 turns a master key into three. */
function derive(masterKey, masterSalt, label, length) {
  const iv = Buffer.alloc(16);
  masterSalt.copy(iv, 0, 0, MASTER_SALT_BYTES);
  // The label sits at bits 48..55 of the 112-bit salt, then 16 zero bits are
  // appended to make the counter block.
  iv[7] ^= label;
  const cipher = createCipheriv('aes-128-ctr', masterKey, iv);
  return Buffer.concat([cipher.update(Buffer.alloc(length)), cipher.final()]);
}

/** A fresh master key and salt, as the `inline:` form the SDP carries. */
export function newKeyMaterial() {
  return { key: randomBytes(MASTER_KEY_BYTES), salt: randomBytes(MASTER_SALT_BYTES) };
}

export const inlineKey = ({ key, salt }) => Buffer.concat([key, salt]).toString('base64');

/**
 * `a=crypto:1 AES_CM_128_HMAC_SHA1_80 inline:AAAA...`
 *
 * Returns null for a profile this gateway cannot do, so the caller can refuse
 * the call instead of answering with a key nobody can use.
 */
export function parseCryptoAttribute(value) {
  const text = String(value || '').trim();
  const match = /^(\d+)\s+([A-Za-z0-9_]+)\s+inline:([A-Za-z0-9+/=]+)/.exec(text);
  if (!match) return null;
  if (match[2] !== PROFILE) return null;
  const material = Buffer.from(match[3], 'base64');
  if (material.length < MASTER_KEY_BYTES + MASTER_SALT_BYTES) return null;
  return {
    tag: Number(match[1]),
    profile: match[2],
    key: material.subarray(0, MASTER_KEY_BYTES),
    salt: material.subarray(MASTER_KEY_BYTES, MASTER_KEY_BYTES + MASTER_SALT_BYTES),
  };
}

export function cryptoAttribute({ tag = 1, key, salt } = {}) {
  return `${tag} ${PROFILE} inline:${inlineKey({ key, salt })}`;
}

/**
 * One direction of an SRTP stream.
 *
 * A call has two of these per leg — one keyed with what we sent, one with what
 * the far side sent — because SDES gives each direction its own master key.
 */
export class SrtpContext {
  constructor({ key, salt }) {
    if (!key || key.length !== MASTER_KEY_BYTES) throw new Error('srtp: master key must be 128 bits');
    if (!salt || salt.length !== MASTER_SALT_BYTES) throw new Error('srtp: master salt must be 112 bits');
    this.encryptionKey = derive(key, salt, LABEL_ENCRYPTION_KEY, MASTER_KEY_BYTES);
    this.authKey = derive(key, salt, LABEL_AUTH_KEY, 20);
    this.salt = derive(key, salt, LABEL_SALT, MASTER_SALT_BYTES);
    // 48-bit packet index, and the rollover counter that extends its high bits.
    // A call that runs long enough to wrap 16 bits of sequence numbers must not
    // restart the keystream, or two packets share a counter block.
    this.roc = 0;
    this.lastSeq = -1;
  }

  index(seq, roc) {
    return roc * 0x1_0000 + seq;
  }

  counterBlock(index) {
    const iv = Buffer.alloc(16);
    this.salt.copy(iv, 0, 0, MASTER_SALT_BYTES);
    // XOR the 48-bit index into the low six bytes of the 128-bit block.
    for (let i = 0; i < 6; i += 1) {
      iv[10 + i] ^= (index / 2 ** (8 * (5 - i))) & 0xff;
    }
    return iv;
  }

  keystream(index, length) {
    const cipher = createCipheriv('aes-128-ctr', this.encryptionKey, this.counterBlock(index));
    return Buffer.concat([cipher.update(Buffer.alloc(length)), cipher.final()]);
  }

  /** HMAC-SHA1 over the packet and the rollover counter, truncated to 80 bits. */
  authTag(packet, roc) {
    const rocBytes = Buffer.alloc(4);
    rocBytes.writeUInt32BE(roc >>> 0, 0);
    return createHmac('sha1', this.authKey).update(packet).update(rocBytes).digest().subarray(0, TAG_BYTES);
  }

  /** Encrypt one RTP packet as sent, appending the authentication tag. */
  protect(packet) {
    const seq = packet.readUInt16BE(2);
    if (this.lastSeq >= 0 && seq < this.lastSeq && this.lastSeq - seq > 0x8000) this.roc += 1;
    this.lastSeq = seq;
    const index = this.index(seq, this.roc);
    const header = packet.subarray(0, 12);
    const payload = packet.subarray(12);
    const mask = this.keystream(index, payload.length);
    const encrypted = Buffer.alloc(payload.length);
    for (let i = 0; i < payload.length; i += 1) encrypted[i] = payload[i] ^ mask[i];
    const body = Buffer.concat([header, encrypted]);
    return Buffer.concat([body, this.authTag(body, this.roc)]);
  }

  /** Decrypt one RTP packet as received. Returns null when it does not authenticate. */
  unprotect(packet) {
    if (packet.length < 12 + TAG_BYTES) return null;
    const body = packet.subarray(0, packet.length - TAG_BYTES);
    const tag = packet.subarray(packet.length - TAG_BYTES);
    const seq = body.readUInt16BE(2);
    if (this.lastSeq >= 0 && seq < this.lastSeq && this.lastSeq - seq > 0x8000) this.roc += 1;
    this.lastSeq = seq;
    const expected = this.authTag(body, this.roc);
    // Constant time: a comparison that leaks where a forged packet first differs
    // is a tag oracle.
    if (!timingSafeEqual(tag, expected)) return null;
    const index = this.index(seq, this.roc);
    const header = body.subarray(0, 12);
    const payload = body.subarray(12);
    const mask = this.keystream(index, payload.length);
    const plain = Buffer.alloc(payload.length);
    for (let i = 0; i < payload.length; i += 1) plain[i] = payload[i] ^ mask[i];
    return Buffer.concat([header, plain]);
  }
}
