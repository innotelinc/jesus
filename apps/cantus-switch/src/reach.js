/**
 * Reach: candidate lists, path tokens and the decisions that make a call
 * connect behind NAT or say why it cannot (§8).
 */

import { createHash } from 'node:crypto';
import { varint, readVarint } from './wire.js';

export const KIND_UDP4 = 0;
export const KIND_UDP6 = 1;
export const KIND_TCP = 2;
export const PATH_DIRECT = 0;
export const PATH_RELAY = 1;
export const PATH_NAMES = ['direct', 'relay'];

export function encodeCandidates(cands) {
  const parts = [varint(cands.length)];
  for (const cand of cands) {
    const ip = Buffer.from(cand.ip || '0.0.0.0', 'utf8');
    const token = Buffer.from(cand.token || Buffer.alloc(8));
    parts.push(varint(cand.kind ?? KIND_UDP4));
    parts.push(varint(ip.length), ip);
    parts.push(varint(cand.port ?? 0));
    parts.push(varint(cand.priority ?? 100));
    parts.push(varint(token.length), token);
  }
  return Buffer.concat(parts);
}

export function decodeCandidates(buf) {
  if (!buf || !buf.length) return [];
  let pos = 0;
  const count = readVarint(buf, pos);
  pos = count.pos;
  if (count.value > 16) throw new Error('cantus: too many candidates');
  const out = [];
  for (let i = 0; i < count.value; i += 1) {
    const kind = readVarint(buf, pos);
    pos = kind.pos;
    const len = readVarint(buf, pos);
    pos = len.pos;
    if (pos + len.value > buf.length) throw new Error('cantus: truncated candidate');
    const ip = buf.subarray(pos, pos + len.value).toString('utf8');
    pos += len.value;
    const port = readVarint(buf, pos);
    pos = port.pos;
    const priority = readVarint(buf, pos);
    pos = priority.pos;
    const tlen = readVarint(buf, pos);
    pos = tlen.pos;
    const token = buf.subarray(pos, pos + tlen.value);
    pos += tlen.value;
    out.push({ kind: kind.value, ip, port: port.value, priority: priority.value, token });
  }
  return out;
}

/** 8-octet candidate token. Both sides derive it from the call, so it is checkable. */
export function candidateToken(call, gen) {
  return createHash('sha256').update(`cantus/1-cand:${call}:${gen}`).digest().subarray(0, 8);
}

/** 16-octet probe challenge, derived the same way on both sides. */
export function challenge(call, gen) {
  return createHash('sha256').update(`cantus/1-path:${call}:${gen}`).digest().subarray(0, 16);
}

export const candidateAddr = (cand) => `${cand.ip}:${cand.port}`;

/** Encode the observed-address field a relay reports back (§8.3). */
export function encodeObserved(family, ip, port) {
  const bytes = Buffer.from(ip, 'utf8');
  return Buffer.concat([varint(family), varint(bytes.length), bytes, varint(port)]);
}

export function decodeObserved(buf) {
  let pos = 0;
  const family = readVarint(buf, pos);
  pos = family.pos;
  const len = readVarint(buf, pos);
  pos = len.pos;
  const ip = buf.subarray(pos, pos + len.value).toString('utf8');
  pos += len.value;
  const port = readVarint(buf, pos);
  return { family: family.value, ip, port: port.value, addr: `${ip}:${port.value}` };
}
