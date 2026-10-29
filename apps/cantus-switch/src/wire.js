/**
 * Cantus 1.0 wire format.
 *
 * A faithful port of `lib/Cantus/Wire.pm` from the reference stack: varints,
 * typed TLV fields, the three datagram kinds (control, media, relay) and the
 * canonical signing input. The byte layout is normative in
 * `apps/cantus/spec/CANTUS-1.0.md` §4.3, §5.1, §5.2 and §9.1, and the Perl
 * implementation is what this one is checked against in `test/wire.test.js`.
 */

export const MAGIC = 0xca;
export const VERSION_TOKEN = 'cantus/1';
export const MAX_DATAGRAM = 1150;

/** Datagram kinds (the second octet). */
export const KIND_CONTROL = 0;
export const KIND_MEDIA = 1;
export const KIND_RELAY = 2;

export const TYPES = {
  HELLO: 1,
  HELLO_ACK: 2,
  INVITE: 3,
  RING: 4,
  ACCEPT: 5,
  REJECT: 6,
  TERMINATE: 7,
  PATH: 8,
  PATH_ACK: 9,
  FEEDBACK: 10,
  PROBE: 11,
  INFO: 12,
  REGISTER: 13,
  REGISTER_ACK: 14,
};

export const TYPE_NAMES = Object.fromEntries(Object.entries(TYPES).map(([name, id]) => [id, name]));

/** Message types that carry a key-bound signature (§10.2). */
export const SIGNED = new Set(['HELLO', 'HELLO_ACK', 'INVITE', 'ACCEPT', 'TERMINATE', 'REGISTER', 'REGISTER_ACK']);

/** Field ids (§5.2). */
export const F = {
  from: 1,
  to: 2,
  call: 3,
  nonce: 4,
  sig: 5,
  gen: 6,
  reason: 7,
  text: 8,
  caps: 9,
  limits: 10,
  node: 11,
  cands: 12,
  token: 13,
  path: 14,
  handle: 15,
  time: 16,
  payload: 17,
  event: 18,
  observed: 19,
  grant: 20,
  version: 21,
  stream: 22,
  report: 23,
  key: 24,
};

// ---------------------------------------------------------------- varints ---

export function varint(value) {
  let n = Math.trunc(value);
  if (!Number.isFinite(n) || n < 0) throw new Error('cantus: negative varint');
  const out = [];
  for (;;) {
    const byte = n & 0x7f;
    n = Math.floor(n / 128);
    if (n) out.push(byte | 0x80);
    else {
      out.push(byte);
      return Buffer.from(out);
    }
  }
}

export function readVarint(buf, pos = 0) {
  let value = 0;
  let shift = 0;
  let count = 0;
  for (;;) {
    if (pos >= buf.length) throw new Error('cantus: truncated varint');
    const byte = buf[pos++];
    value += (byte & 0x7f) * 2 ** shift;
    count += 1;
    if (!(byte & 0x80)) return { value, pos };
    if (count >= 9) throw new Error('cantus: varint longer than 9 octets');
    shift += 7;
  }
}

// ------------------------------------------------------------- typed fields -

export const v = (n) => ({ wt: 0, v: Math.trunc(n) }); //   varint
export const s = (str) => ({ wt: 2, v: Buffer.from(String(str), 'utf8') }); // string
export const b = (buf) => ({ wt: 2, v: Buffer.from(buf) }); // opaque bytes
export const u64 = (n) => ({ wt: 1, v: BigInt(n) }); //       fixed64
export const u32 = (n) => ({ wt: 5, v: n >>> 0 }); //         fixed32

function valueBytes(spec) {
  switch (spec.wt) {
    case 0:
      return varint(spec.v);
    case 2:
      return Buffer.from(spec.v);
    case 1: {
      const out = Buffer.alloc(8);
      out.writeBigUInt64LE(BigInt(spec.v));
      return out;
    }
    case 5: {
      const out = Buffer.alloc(4);
      out.writeUInt32LE(spec.v >>> 0);
      return out;
    }
    default:
      throw new Error(`cantus: bad wire type ${spec.wt}`);
  }
}

/** Read a field's value out of the decoded map as a string. */
export function asString(fields, id) {
  const field = fields?.[id];
  if (!field) return undefined;
  return Buffer.from(field.v).toString('utf8');
}

/** Read a field's value as a number. */
export function asNumber(fields, id) {
  const field = fields?.[id];
  if (!field) return undefined;
  return field.wt === 1 ? Number(field.v) : field.v;
}

// ------------------------------------------------------------------ control --

/**
 * Encode a CONTROL datagram. Fields are emitted in ascending id order, because
 * the canonical byte order is part of the signature (§10.2).
 */
export function encodeMsg(type, fields = {}) {
  const parts = [Buffer.from([MAGIC, KIND_CONTROL]), varint(type)];
  for (const id of Object.keys(fields).map(Number).sort((a, b2) => a - b2)) {
    const spec = fields[id];
    if (!spec) continue;
    parts.push(varint((id << 3) | spec.wt));
    if (spec.wt === 2) {
      const bytes = Buffer.from(spec.v);
      parts.push(varint(bytes.length), bytes);
    } else {
      parts.push(valueBytes(spec));
    }
  }
  const out = Buffer.concat(parts);
  if (out.length > MAX_DATAGRAM) throw new Error('cantus: datagram exceeds 1150 octets');
  return out;
}

export function decodeMsg(buf) {
  if (buf.length < 3) throw new Error('cantus: short datagram');
  if (buf[0] !== MAGIC) throw new Error('cantus: bad magic');
  if (buf[1] !== KIND_CONTROL) throw new Error('cantus: not a control datagram');
  let pos = 2;
  const head = readVarint(buf, pos);
  const type = head.value;
  pos = head.pos;
  const fields = {};
  let count = 0;
  while (pos < buf.length) {
    const tag = readVarint(buf, pos);
    pos = tag.pos;
    const id = Math.floor(tag.value / 8);
    const wt = tag.value & 0x7;
    if (id < 1 || id > 4095) throw new Error('cantus: field id out of range');
    count += 1;
    if (count > 64) throw new Error('cantus: too many fields');
    if (wt === 0) {
      const read = readVarint(buf, pos);
      pos = read.pos;
      fields[id] = { wt: 0, v: read.value };
    } else if (wt === 2) {
      const read = readVarint(buf, pos);
      pos = read.pos;
      if (pos + read.value > buf.length) throw new Error('cantus: truncated field');
      fields[id] = { wt: 2, v: buf.subarray(pos, pos + read.value) };
      pos += read.value;
    } else if (wt === 1) {
      if (pos + 8 > buf.length) throw new Error('cantus: truncated fixed64');
      fields[id] = { wt: 1, v: buf.readBigUInt64LE(pos) };
      pos += 8;
    } else if (wt === 5) {
      if (pos + 4 > buf.length) throw new Error('cantus: truncated fixed32');
      fields[id] = { wt: 5, v: buf.readUInt32LE(pos) };
      pos += 4;
    } else {
      throw new Error(`cantus: unknown wire type ${wt}`);
    }
  }
  return { type, fields };
}

// -------------------------------------------------------------------- media --

export function encodeMedia({ stream = 0, tag = 0, seq = 0, ts = 0, codec = 2, flags = 0, payload = Buffer.alloc(0) }) {
  return Buffer.concat([
    Buffer.from([MAGIC, KIND_MEDIA]),
    varint(stream),
    varint(tag),
    varint(seq),
    varint(ts),
    varint(codec),
    varint(flags),
    Buffer.from(payload),
  ]);
}

export function decodeMedia(buf) {
  if (buf.length < 10) throw new Error('cantus: bad media datagram');
  if (buf[0] !== MAGIC) throw new Error('cantus: bad magic');
  if (buf[1] !== KIND_MEDIA) throw new Error('cantus: not a media datagram');
  let pos = 2;
  const out = {};
  for (const key of ['stream', 'tag', 'seq', 'ts', 'codec', 'flags']) {
    const read = readVarint(buf, pos);
    out[key] = read.value;
    pos = read.pos;
  }
  out.payload = buf.subarray(pos);
  return out;
}

// -------------------------------------------------------------------- relay --

/**
 * RELAY = magic 0x02 route:varint [name:string when route == 0] inner.
 * `route == 0` addresses a peer by EndpointId and lets the relay resolve it.
 */
export function encodeRelay(route, inner, name = '') {
  const parts = [Buffer.from([MAGIC, KIND_RELAY]), varint(route)];
  if (!route) {
    const bytes = Buffer.from(String(name), 'utf8');
    parts.push(varint(bytes.length), bytes);
  }
  parts.push(Buffer.from(inner));
  return Buffer.concat(parts);
}

export function decodeRelay(buf) {
  if (buf.length < 3) throw new Error('cantus: bad relay datagram');
  if (buf[0] !== MAGIC) throw new Error('cantus: bad magic');
  if (buf[1] !== KIND_RELAY) throw new Error('cantus: not a relay datagram');
  let pos = 2;
  const read = readVarint(buf, pos);
  const route = read.value;
  pos = read.pos;
  let name = '';
  if (route === 0) {
    const len = readVarint(buf, pos);
    pos = len.pos;
    if (pos + len.value > buf.length) throw new Error('cantus: truncated relay name');
    name = buf.subarray(pos, pos + len.value).toString('utf8');
    pos += len.value;
  }
  return { route, name, inner: buf.subarray(pos) };
}

export function datagramKind(buf) {
  if (!buf || buf.length < 2) return undefined;
  if (buf[0] !== MAGIC) return undefined;
  return buf[1];
}

// --------------------------------------------------------------- signatures --

/** Canonical signing input, §10.2. Field 5 (sig) is excluded. */
export function signingInput(type, fields) {
  const parts = [Buffer.from(`${VERSION_TOKEN}-sig`, 'utf8'), varint(type)];
  for (const id of Object.keys(fields).map(Number).sort((a, b2) => a - b2)) {
    if (id === 5) continue;
    const spec = fields[id];
    if (!spec) continue;
    const bytes = valueBytes(spec);
    parts.push(varint(id), varint(bytes.length), bytes);
  }
  return Buffer.concat(parts);
}

/** Plain-text rendering for logs and the CLI (`bin/cantus` prints the same shape). */
export function describe(type, fields = {}) {
  const short = Object.fromEntries(Object.entries(F).map(([name, id]) => [id, name]));
  const parts = [];
  for (const id of Object.keys(fields).map(Number).sort((a, b2) => a - b2)) {
    const field = fields[id];
    const name = short[id] || `f${id}`;
    let shown;
    if (field.wt === 2) {
      const str = Buffer.from(field.v).toString('utf8');
      shown = /^[\x20-\x7e]{0,40}$/.test(str) ? JSON.stringify(str) : `${field.v.length} bytes`;
    } else {
      shown = String(field.v);
    }
    parts.push(`${name}=${shown}`);
  }
  return `${TYPE_NAMES[type] || `TYPE_${type}`} ${parts.join(' ')}`.trim();
}
