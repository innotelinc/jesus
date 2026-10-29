/**
 * Media helpers: the conformance codec, the receiver quality report, G.711 and
 * the WAV container the switch writes for recordings and voicemail.
 *
 * §9.5 is the reason the report exists at all: `recv_high` is the only way a
 * sender can learn that its own packets are not landing, because no local
 * counter can tell the difference between "sent" and "received".
 */

import { varint, readVarint } from './wire.js';

export const PCM_RATE = 8000;
export const OPUS_RATE = 48000;

const REPORT_FIELDS = ['loss_q8', 'rtt_us', 'jitter_us', 'recv_kbps', 'desired_kbps', 'frames_lost', 'recv_high'];

export function frameSamples(ptime = 20, rate = PCM_RATE) {
  return Math.round((rate * ptime) / 1000);
}

/** The pcm-s16 test codec: a sine tone, little-endian signed 16-bit. */
export function pcmFrame({ hz = 440, amp = 6000, samples = 160, phase = 0, rate = PCM_RATE } = {}) {
  const out = Buffer.alloc(samples * 2);
  const step = (2 * Math.PI * hz) / rate;
  let p = phase;
  for (let i = 0; i < samples; i += 1) {
    out.writeInt16LE(Math.trunc(amp * Math.sin(p)), i * 2);
    p += step;
  }
  return { payload: out, phase: p % (2 * Math.PI) };
}

export function silence(samples = 160) {
  return Buffer.alloc(samples * 2);
}

export function peak(payload) {
  let max = 0;
  for (let i = 0; i + 1 < payload.length; i += 2) {
    const value = Math.abs(payload.readInt16LE(i));
    if (value > max) max = value;
  }
  return max;
}

export function encodeReport(report) {
  return Buffer.concat(REPORT_FIELDS.map((key) => varint(report[key] || 0)));
}

export function decodeReport(buf) {
  const out = {};
  if (!buf) return out;
  let pos = 0;
  for (const key of REPORT_FIELDS) {
    if (pos >= buf.length) break;
    // A peer that predates recv_high sends fewer fields; a missing tail is not
    // an error, it only means it cannot report reception.
    const read = readVarint(buf, pos);
    out[key] = read.value;
    pos = read.pos;
  }
  return out;
}

// -------------------------------------------------------------------- G.711 --

const ULAW_BIAS = 0x84;
const ULAW_CLIP = 32635;

/** Linear PCM16 → 8-bit µ-law (the codec every PSTN leg speaks). */
export function linearToUlaw(sample) {
  let value = Math.max(-ULAW_CLIP, Math.min(ULAW_CLIP, sample));
  let sign = 0;
  if (value < 0) {
    sign = 0x80;
    value = -value;
  }
  value += ULAW_BIAS;
  let exponent = 7;
  for (let mask = 0x4000; (value & mask) === 0 && exponent > 0; mask >>= 1) exponent -= 1;
  const mantissa = (value >> (exponent + 3)) & 0x0f;
  return ~(sign | (exponent << 4) | mantissa) & 0xff;
}

export function ulawToLinear(byte) {
  const value = ~byte & 0xff;
  const sign = value & 0x80;
  const exponent = (value >> 4) & 0x07;
  const mantissa = value & 0x0f;
  let sample = ((mantissa << 3) + ULAW_BIAS) << exponent;
  sample -= ULAW_BIAS;
  return sign ? -sample : sample;
}

export function pcm16ToUlaw(payload) {
  const out = Buffer.alloc(payload.length >> 1);
  for (let i = 0, o = 0; i + 1 < payload.length; i += 2, o += 1) {
    out[o] = linearToUlaw(payload.readInt16LE(i));
  }
  return out;
}

export function ulawToPcm16(payload) {
  const out = Buffer.alloc(payload.length * 2);
  for (let i = 0; i < payload.length; i += 1) out.writeInt16LE(ulawToLinear(payload[i]), i * 2);
  return out;
}

/** 2× linear upsample (8 kHz → 16 kHz), for endpoints that ask for slin16. */
export function upsample2(payload) {
  const samples = payload.length >> 1;
  const out = Buffer.alloc(samples * 4);
  for (let i = 0; i < samples; i += 1) {
    const current = payload.readInt16LE(i * 2);
    const next = i + 1 < samples ? payload.readInt16LE(i * 2 + 2) : current;
    out.writeInt16LE(current, i * 4);
    out.writeInt16LE(Math.round((current + next) / 2), i * 4 + 2);
  }
  return out;
}

/** 2× linear downsample (16 kHz → 8 kHz). */
export function downsample2(payload) {
  const samples = payload.length >> 2;
  const out = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i += 1) {
    const a = payload.readInt16LE(i * 4);
    const b = payload.readInt16LE(i * 4 + 2);
    out.writeInt16LE(Math.round((a + b) / 2), i * 2);
  }
  return out;
}

// ---------------------------------------------------------------------- WAV --

/** Wrap PCM16 in a RIFF/WAVE container so a recording can just be played. */
export function wavWrap(pcm, { rate = PCM_RATE, channels = 1 } = {}) {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * channels * 2, 28);
  header.writeUInt16LE(channels * 2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

/** Convert a µ-law payload to the same WAV container (8 kHz). */
export function ulawWav(ulawPayload) {
  return wavWrap(ulawToPcm16(ulawPayload), { rate: 8000 });
}
