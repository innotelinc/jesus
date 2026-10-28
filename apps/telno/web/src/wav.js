/**
 * A recording, in the one format the platform's voiceprint reads.
 *
 * MediaRecorder gives whatever the browser likes — WebM/Opus in Chrome, MP4/AAC
 * in Safari — and decoding Opus on the server would mean shipping a codec. So
 * the page decodes its own recording (it has the codec already), mixes it to
 * mono, resamples to 16 kHz and encodes a plain PCM WAV. Two hundred kilobytes
 * of audio, no dependency on either side of the wire.
 */

const TARGET_RATE = 16000;

function context() {
  const Ctor = window.AudioContext || window.webkitAudioContext;
  if (!Ctor) throw new Error('This browser cannot decode audio');
  return new Ctor();
}

function toMono(buffer) {
  const channels = buffer.numberOfChannels;
  const length = buffer.length;
  const out = new Float32Array(length);
  for (let channel = 0; channel < channels; channel += 1) {
    const data = buffer.getChannelData(channel);
    for (let i = 0; i < length; i += 1) out[i] += data[i] / channels;
  }
  return out;
}

function resample(samples, from, to = TARGET_RATE) {
  if (from === to) return samples;
  const ratio = from / to;
  const length = Math.max(1, Math.floor(samples.length / ratio));
  const out = new Float32Array(length);
  for (let i = 0; i < length; i += 1) {
    const at = i * ratio;
    const low = Math.floor(at);
    const high = Math.min(low + 1, samples.length - 1);
    const frac = at - low;
    out[i] = samples[low] * (1 - frac) + samples[high] * frac;
  }
  return out;
}

/** 16-bit PCM WAV with a canonical 44-byte header. */
function encodeWav(samples, rate = TARGET_RATE) {
  const bytes = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(bytes);
  const text = (offset, value) => {
    for (let i = 0; i < value.length; i += 1) view.setUint8(offset + i, value.charCodeAt(i));
  };
  text(0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  text(8, 'WAVE');
  text(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, 'data');
  view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i += 1) {
    const value = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(44 + i * 2, value < 0 ? value * 0x8000 : value * 0x7fff, true);
  }
  return new Uint8Array(bytes);
}

function base64(bytes) {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return window.btoa(binary);
}

/**
 * Decode a recording to a base64 WAV at 16 kHz mono.
 *
 * `maxSeconds` mirrors the server's limit, so a long take is trimmed here rather
 * than uploaded and refused.
 */
export async function recordedWav(blob, { maxSeconds = 20 } = {}) {
  if (!blob || !blob.size) throw new Error('Nothing was recorded');
  const ctx = context();
  try {
    const decoded = await ctx.decodeAudioData(await blob.arrayBuffer());
    const mono = toMono(decoded);
    const resampled = resample(mono, decoded.sampleRate);
    const cap = Math.min(resampled.length, TARGET_RATE * maxSeconds);
    const trimmed = resampled.subarray(0, cap);
    return {
      base64: base64(encodeWav(trimmed)),
      seconds: Number((trimmed.length / TARGET_RATE).toFixed(2)),
      sampleRate: TARGET_RATE,
    };
  } finally {
    ctx.close().catch(() => {});
  }
}
