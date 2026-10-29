/**
 * Capability sets and one-round-trip negotiation (§6).
 *
 * A capability is ordered data, not SDP text: two lists go out, one comes back
 * agreed, and the caller's order decides. Nothing re-offers.
 */

import { varint, readVarint } from './wire.js';

const take = (buf, pos) => {
  const len = readVarint(buf, pos);
  const end = len.pos + len.value;
  if (end > buf.length) throw new Error('cantus: truncated string');
  return { value: buf.subarray(len.pos, end).toString('utf8'), pos: end };
};

export function encodeCaps(caps) {
  const parts = [varint(caps.length)];
  for (const cap of caps) {
    const name = Buffer.from(cap.name, 'utf8');
    const params = Object.entries(cap.params || {}).sort(([a], [b]) => a.localeCompare(b));
    parts.push(varint(name.length), name);
    parts.push(varint(cap.ptime ?? 20));
    parts.push(varint(cap.bitrate ?? 0));
    parts.push(varint(params.length));
    for (const [key, value] of params) {
      const k = Buffer.from(key, 'utf8');
      const val = Buffer.from(String(value), 'utf8');
      parts.push(varint(k.length), k, varint(val.length), val);
    }
  }
  return Buffer.concat(parts);
}

export function decodeCaps(buf) {
  if (!buf || !buf.length) return [];
  let pos = 0;
  const read = readVarint(buf, pos);
  pos = read.pos;
  if (read.value > 32) throw new Error('cantus: too many capabilities');
  const caps = [];
  for (let i = 0; i < read.value; i += 1) {
    const name = take(buf, pos);
    pos = name.pos;
    const ptime = readVarint(buf, pos);
    pos = ptime.pos;
    const bitrate = readVarint(buf, pos);
    pos = bitrate.pos;
    const count = readVarint(buf, pos);
    pos = count.pos;
    if (count.value > 32) throw new Error('cantus: too many codec parameters');
    const params = {};
    for (let p = 0; p < count.value; p += 1) {
      const k = take(buf, pos);
      pos = k.pos;
      const val = take(buf, pos);
      pos = val.pos;
      params[k.value] = val.value;
    }
    caps.push({ name: name.value, ptime: ptime.value, bitrate: bitrate.value, params });
  }
  return caps;
}

const parts = (name) => {
  const [base, clock, chan] = String(name).toLowerCase().split('/');
  return { base, clock: Number(clock || 48000), chan: Number(chan || 1) };
};

export function codecId(name) {
  const { base } = parts(name);
  if (base === 'opus') return 1;
  if (base === 'pcm-s16') return 2;
  if (base === 'red') return 3;
  return 0;
}

export function codecRate(name) {
  return parts(name).clock || 48000;
}

/**
 * §6.2: walk the offer in order and take the first answer entry with the same
 * base name and a compatible clock and channel count. Exactly one codec
 * results, and the caller's order is what chose it.
 */
export function negotiate(offer, answer) {
  for (const o of offer || []) {
    const op = parts(o.name);
    for (const a of answer || []) {
      const ap = parts(a.name);
      if (op.base !== ap.base) continue;
      if (op.clock !== ap.clock || op.chan !== ap.chan) continue;
      return {
        name: o.name,
        codec: codecId(o.name),
        rate: codecRate(o.name),
        ptime: a.ptime || o.ptime || 20,
        bitrate: a.bitrate || o.bitrate || 0,
        params: { ...(o.params || {}), ...(a.params || {}) },
      };
    }
  }
  return undefined;
}

/** The production offer: Opus, as the standard intends. */
export function productionSet() {
  return [
    { name: 'opus/48000/2', ptime: 20, bitrate: 32, params: { useinbandfec: '1', dtx: '1', maxaveragebitrate: '32000' } },
    { name: 'opus/48000/1', ptime: 20, bitrate: 24, params: { useinbandfec: '1', dtx: '1' } },
  ];
}

/**
 * The set this switch offers. 8 kHz mono PCM leads because every leg it lights
 * up today — a browser softphone, a media bridge to an agent, a recording — is
 * narrowband telephony, and 320 octets per 20 ms frame keeps a datagram well
 * inside the 1150-octet limit (§13). Opus follows for endpoints that prefer it.
 */
export function telephoneSet() {
  return [
    { name: 'pcm-s16/8000/1', ptime: 20, bitrate: 128, params: {} },
    { name: 'opus/48000/1', ptime: 20, bitrate: 24, params: { useinbandfec: '1' } },
  ];
}

export function describeCaps(caps) {
  return (caps || [])
    .map((cap) => {
      const extra = Object.entries(cap.params || {})
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => `${k}=${v}`)
        .join(';');
      return `${cap.name}/${cap.ptime}${extra ? `[${extra}]` : ''}`;
    })
    .join(', ');
}
