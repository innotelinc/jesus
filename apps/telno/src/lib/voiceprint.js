/**
 * Voiceprints — a check that the person holding the phone is the person the line
 * belongs to.
 *
 * Why this is here rather than in the browser: a check the client performs is a
 * suggestion. The embedding is computed from the audio on this side, so a page
 * that claims "voice matched" without a recording gets nowhere.
 *
 * What it is: mel-frequency cepstral statistics (MFCC mean, spread and delta
 * statistics) compared by cosine similarity. That is a real, dependency-free
 * speaker feature — it captures the spectral shape of a voice, which is what
 * makes two people sound different — but it is not a trained speaker-recognition
 * network. It is a second factor for a phone line, not a biometric lock on a
 * bank account, and docs/SCIF.md says so. The embedding function is deliberately
 * a single seam: swapping in ECAPA-TDNN or an x-vector model later changes
 * `embeddingFromWav` and the stored vectors are re-enrolled, nothing else.
 *
 * Audio in: 16-bit (or float) PCM WAV. The browser decodes its own recording to
 * 16 kHz mono WAV before upload, which is why no Opus decoder is needed here.
 */

import { createHash } from 'node:crypto';
import { db_, newId, now } from '../db/index.js';
import { config } from '../config.js';
import { badRequest, forbidden, notFound, tooMany } from './errors.js';

const TARGET_RATE = 16000;
const FRAME = 400; // 25 ms at 16 kHz
const HOP = 160; // 10 ms
const FFT_SIZE = 512;
const MEL_BANDS = 26;
const CEPSTRA = 13; // c0..c12; c0 is energy and is used separately
// Anything quieter than this below the loudest frame is silence, not speech.
const SILENCE_FLOOR_DB = 35;
// Below this a frame is not speech at all, however quiet the rest of the take is.
const ABSOLUTE_FLOOR_DB = -65;
const MIN_VOICED_FRAMES = 25; // a quarter of a second of actual speech

/* ------------------------------------------------------------------- wav -- */

const ASCII = (view, offset, length) => {
  let out = '';
  for (let i = 0; i < length; i += 1) out += String.fromCharCode(view.getUint8(offset + i));
  return out;
};

/**
 * Decode a PCM WAV into mono float samples at 16 kHz.
 *
 * Only integer PCM and IEEE float are accepted. A compressed WAV (ADPCM, mu-law)
 * is refused rather than misread: a wrong decode produces a confident, wrong
 * embedding, which is worse than an error.
 */
export function decodeWav(buffer) {
  if (!buffer || buffer.length < 44) throw badRequest('That audio is not a WAV file');
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  if (ASCII(view, 0, 4) !== 'RIFF' || ASCII(view, 8, 4) !== 'WAVE') {
    throw badRequest('That audio is not a WAV file');
  }

  let format = null;
  let data = null;
  let offset = 12;
  while (offset + 8 <= view.byteLength) {
    const id = ASCII(view, offset, 4);
    const size = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (id === 'fmt ') {
      format = {
        codec: view.getUint16(body, true),
        channels: view.getUint16(body + 2, true),
        rate: view.getUint32(body + 4, true),
        bits: view.getUint16(body + 14, true),
      };
    } else if (id === 'data') {
      data = { start: body, length: Math.min(size, view.byteLength - body) };
    }
    // Chunks are word-aligned: an odd size is followed by a pad byte.
    offset = body + size + (size % 2);
  }
  if (!format || !data) throw badRequest('That WAV file has no audio in it');
  if (![1, 3].includes(format.codec)) throw badRequest('Only uncompressed PCM WAV is supported');
  if (!format.channels || format.channels > 2) throw badRequest('Only mono or stereo audio is supported');
  if (!format.rate || format.rate < 8000 || format.rate > 48000) throw badRequest('That sample rate is not supported');

  const bytes = format.bits / 8;
  const frames = Math.floor(data.length / (bytes * format.channels));
  if (frames < format.rate * 0.2) throw badRequest('That recording is too short');

  const mono = new Float32Array(frames);
  for (let i = 0; i < frames; i += 1) {
    let sum = 0;
    for (let channel = 0; channel < format.channels; channel += 1) {
      const at = data.start + (i * format.channels + channel) * bytes;
      let sample;
      if (format.codec === 3 && format.bits === 32) sample = view.getFloat32(at, true);
      else if (format.bits === 16) sample = view.getInt16(at, true) / 32768;
      else if (format.bits === 8) sample = (view.getUint8(at) - 128) / 128;
      else if (format.bits === 24) {
        const low = view.getUint8(at);
        const mid = view.getUint8(at + 1);
        const high = view.getInt8(at + 2);
        sample = ((high << 16) | (mid << 8) | low) / 8388608;
      } else if (format.bits === 32) sample = view.getInt32(at, true) / 2147483648;
      else throw badRequest(`Unsupported sample width: ${format.bits} bits`);
      sum += sample;
    }
    mono[i] = sum / format.channels;
  }

  return {
    sampleRate: format.rate,
    seconds: frames / format.rate,
    samples: resample(mono, format.rate, TARGET_RATE),
  };
}

/** Linear resampling. Speech features survive it; a sinc filter would not change them. */
export function resample(samples, from, to = TARGET_RATE) {
  if (from === to) return samples;
  const ratio = from / to;
  const length = Math.floor(samples.length / ratio);
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

/* ------------------------------------------------------------------- fft -- */

/** In-place radix-2 FFT. `re` and `im` are the real and imaginary parts. */
export function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i += 1) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i];
      re[i] = re[j];
      re[j] = t;
      t = im[i];
      im[i] = im[j];
      im[j] = t;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const angle = (-2 * Math.PI) / len;
    const wRe = Math.cos(angle);
    const wIm = Math.sin(angle);
    for (let i = 0; i < n; i += len) {
      let curRe = 1;
      let curIm = 0;
      for (let k = 0; k < len / 2; k += 1) {
        const aRe = re[i + k];
        const aIm = im[i + k];
        const bRe = re[i + k + len / 2] * curRe - im[i + k + len / 2] * curIm;
        const bIm = re[i + k + len / 2] * curIm + im[i + k + len / 2] * curRe;
        re[i + k] = aRe + bRe;
        im[i + k] = aIm + bIm;
        re[i + k + len / 2] = aRe - bRe;
        im[i + k + len / 2] = aIm - bIm;
        const nextRe = curRe * wRe - curIm * wIm;
        curIm = curRe * wIm + curIm * wRe;
        curRe = nextRe;
      }
    }
  }
  return { re, im };
}

/* ------------------------------------------------------------------ mfcc -- */

const mel = (hz) => 2595 * Math.log10(1 + hz / 700);
const hz = (m) => 700 * (10 ** (m / 2595) - 1);

let filterCache = null;

/** Triangular mel filters from 80 Hz to 7.6 kHz — the band a phone line keeps. */
function melFilters(rate = TARGET_RATE, bins = FFT_SIZE / 2 + 1) {
  if (filterCache && filterCache.rate === rate) return filterCache.filters;
  const low = mel(80);
  const high = mel(Math.min(7600, rate / 2 - 100));
  const points = [];
  for (let i = 0; i < MEL_BANDS + 2; i += 1) points.push(hz(low + ((high - low) * i) / (MEL_BANDS + 1)));
  const filters = [];
  for (let i = 0; i < MEL_BANDS; i += 1) {
    const left = points[i];
    const center = points[i + 1];
    const right = points[i + 2];
    const weights = new Float32Array(bins);
    for (let bin = 0; bin < bins; bin += 1) {
      const freq = (bin * rate) / FFT_SIZE;
      if (freq <= left || freq >= right) continue;
      weights[bin] = freq <= center ? (freq - left) / (center - left) : (right - freq) / (right - center);
    }
    filters.push(weights);
  }
  filterCache = { rate, filters };
  return filters;
}

const hamming = new Float32Array(FRAME).map((_, i) => 0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (FRAME - 1)));

/**
 * Fundamental frequency of one frame, 0 when the frame has no clear period.
 *
 * YIN's difference function, not raw autocorrelation. The naive "first peak"
 * version of this picks the second period as often as the first and reports a
 * voice an octave below where it is — which for a speaker check is worse than
 * reporting nothing at all.
 */
function estimatePitch(samples, start) {
  // 40 ms is the longest period worth checking (25 Hz); 2.5 ms the shortest
  // (400 Hz). Beyond that a telephone line has nothing to say.
  const MAX_LAG = 400;
  const MIN_LAG = 40;
  const length = Math.min(FRAME, samples.length - start);

  const difference = new Float32Array(MAX_LAG + 1);
  for (let lag = 1; lag <= MAX_LAG; lag += 1) {
    let sum = 0;
    for (let i = 0; i < length - lag; i += 1) {
      const delta = samples[start + i] - samples[start + i + lag];
      sum += delta * delta;
    }
    difference[lag] = sum;
  }

  // Cumulative mean normalisation: this is the part that removes the bias
  // towards long lags that makes raw autocorrelation fail at high pitch.
  const normalised = new Float32Array(MAX_LAG + 1);
  let running = 0;
  normalised[0] = 1;
  for (let lag = 1; lag <= MAX_LAG; lag += 1) {
    running += difference[lag];
    normalised[lag] = running === 0 ? 1 : (difference[lag] * lag) / running;
  }

  let bestLag = 0;
  for (let lag = MIN_LAG; lag <= MAX_LAG; lag += 1) {
    if (normalised[lag] < 0.15) {
      // Walk to the bottom of this dip and take a parabolic refinement, so the
      // estimate is not quantised to whole samples.
      let dip = lag;
      while (dip + 1 <= MAX_LAG && normalised[dip + 1] < normalised[dip]) dip += 1;
      const before = normalised[dip - 1] ?? normalised[dip];
      const after = normalised[dip + 1] ?? normalised[dip];
      const denominator = 2 * (2 * normalised[dip] - before - after);
      const shift = denominator === 0 ? 0 : (after - before) / denominator;
      bestLag = dip + shift;
      break;
    }
  }
  if (!bestLag) {
    let lowest = 0.3;
    for (let lag = MIN_LAG; lag <= MAX_LAG; lag += 1) {
      if (normalised[lag] < lowest) {
        lowest = normalised[lag];
        bestLag = lag;
      }
    }
  }
  if (!bestLag) return 0;
  const hz = TARGET_RATE / bestLag;
  return hz >= 40 && hz <= 400 ? hz : 0;
}

/**
 * Frame-level MFCCs, plus how loud and how high each frame is.
 *
 * `voiced` marks the frames loud enough to be speech. Silence is excluded from
 * the statistics: padding a recording with room tone would otherwise pull two
 * different voices towards the same average.
 */
export function mfcc(samples) {
  const filters = melFilters();
  const cepstra = [];
  const energies = [];
  const pre = new Float32Array(samples.length);
  // Pre-emphasis boosts the high frequencies a microphone rolls off, which is
  // where a lot of speaker identity lives.
  pre[0] = samples[0];
  for (let i = 1; i < samples.length; i += 1) pre[i] = samples[i] - 0.97 * samples[i - 1];

  for (let start = 0; start + FRAME <= pre.length; start += HOP) {
    const re = new Float32Array(FFT_SIZE);
    const im = new Float32Array(FFT_SIZE);
    let energy = 0;
    for (let i = 0; i < FRAME; i += 1) {
      const value = pre[start + i] * hamming[i];
      re[i] = value;
      energy += value * value;
    }
    fft(re, im);
    const power = new Float32Array(FFT_SIZE / 2 + 1);
    for (let bin = 0; bin < power.length; bin += 1) power[bin] = (re[bin] * re[bin] + im[bin] * im[bin]) / FFT_SIZE;

    const logMel = new Float32Array(MEL_BANDS);
    for (let band = 0; band < MEL_BANDS; band += 1) {
      const weights = filters[band];
      let sum = 0;
      for (let bin = 0; bin < weights.length; bin += 1) sum += weights[bin] * power[bin];
      logMel[band] = Math.log(Math.max(sum, 1e-12));
    }

    // DCT-II: decorrelates the mel bands into cepstral coefficients.
    const coeffs = new Float32Array(CEPSTRA);
    for (let k = 0; k < CEPSTRA; k += 1) {
      let sum = 0;
      for (let band = 0; band < MEL_BANDS; band += 1) {
        sum += logMel[band] * Math.cos((Math.PI * k * (band + 0.5)) / MEL_BANDS);
      }
      coeffs[k] = sum / MEL_BANDS;
    }
    cepstra.push(coeffs);
    energies.push(10 * Math.log10(Math.max(energy / FRAME, 1e-12)));
  }
  if (!cepstra.length) throw badRequest('That recording is too short');

  const loudest = Math.max(...energies);
  const floor = Math.max(loudest - SILENCE_FLOOR_DB, ABSOLUTE_FLOOR_DB);
  const voiced = energies.map((db) => db > floor);
  const pitch = new Float32Array(cepstra.length);
  for (let i = 0; i < cepstra.length; i += 1) {
    if (voiced[i]) pitch[i] = estimatePitch(pre, i * HOP);
  }
  return { cepstra, energies, voiced, pitch, seconds: samples.length / TARGET_RATE };
}

/**
 * A voiceprint: cepstral statistics of the voiced frames, plus the pitch the
 * voice sat at.
 *
 * Pitch is kept beside the vector rather than inside it. Cepstral coefficients
 * are largely positive, and a cosine over positive vectors *grows* as two voices
 * move apart — the opposite of what a comparison needs. So the cepstra are
 * compared by cosine and pitch separately, as how many octaves apart the two
 * takes were. That is a cue a louder voice or a closer microphone cannot fake.
 */
export function embeddingFromSamples(samples) {
  const { cepstra, voiced, pitch } = mfcc(samples);
  const frames = [];
  for (let i = 0; i < cepstra.length; i += 1) {
    if (voiced[i]) frames.push(Array.from(cepstra[i]).slice(1)); // drop c0 (energy)
  }
  if (frames.length < MIN_VOICED_FRAMES) {
    throw badRequest('There was not enough speech in that recording — try again and keep talking until it stops');
  }

  const dims = frames[0].length;
  const mean = new Array(dims).fill(0);
  for (const frame of frames) for (let d = 0; d < dims; d += 1) mean[d] += frame[d] / frames.length;

  // Cepstral mean normalisation: a different microphone changes the average of
  // every coefficient, and that is exactly the thing to remove.
  const variance = new Array(dims).fill(0);
  const delta = new Array(dims).fill(0);
  for (let i = 0; i < frames.length; i += 1) {
    for (let d = 0; d < dims; d += 1) {
      const centered = frames[i][d] - mean[d];
      variance[d] += (centered * centered) / frames.length;
      if (i > 0) delta[d] += Math.abs(frames[i][d] - frames[i - 1][d]) / (frames.length - 1);
    }
  }

  const pitches = Array.from(pitch).filter((value) => value > 0).sort((a, b) => a - b);
  const medianPitch = pitches.length ? pitches[Math.floor(pitches.length / 2)] : 0;
  const spread = pitches.length
    ? Math.sqrt(pitches.reduce((sum, value) => sum + (value - medianPitch) ** 2, 0) / pitches.length)
    : 0;

  return {
    cepstra: l2([
      ...mean.map((value) => value * 3), // the average spectrum carries the most identity
      ...variance.map((value) => Math.sqrt(value) * 2),
      ...delta.map((value) => value * 2),
    ]),
    pitch: medianPitch,
    spread,
  };
}

export function embeddingFromWav(buffer) {
  const { samples, seconds } = decodeWav(buffer);
  if (seconds > config.voice.maxSeconds + 1) throw badRequest('That recording is too long');
  if (seconds < config.voice.minSeconds * 0.8) throw badRequest('That recording is too short');
  return embeddingFromWavSamples(samples);
}

export function embeddingFromWavSamples(samples) {
  return embeddingFromSamples(samples);
}

function l2(vector) {
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0)) || 1;
  return vector.map((value) => value / norm);
}

/** Cosine similarity, clamped to 0..1 — a negative score is simply "not them". */
export function similarity(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length || !a.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (!normA || !normB) return 0;
  return Math.max(0, Math.min(1, dot / Math.sqrt(normA * normB)));
}

/**
 * How far apart two voices sit, in octaves.
 *
 * A different person is usually several semitones away; the same person on a
 * different day is a fraction of one. Unknown pitch on either side is not held
 * against the attempt — the cepstra still have to agree.
 */
export function pitchFactor(a, b) {
  if (!a || !b || !Number.isFinite(a) || !Number.isFinite(b)) return 1;
  const octaves = Math.abs(Math.log2(a / b));
  return Math.max(0.02, Math.min(1, Math.exp(-(octaves * octaves) / (2 * 0.3 * 0.3))));
}

/** The whole comparison: spectrum by cosine, voice height by octaves. */
export function compare(a, b) {
  if (!a || !b) return 0;
  // A print stored before pitch existed is still a plain vector.
  const left = Array.isArray(a) ? { cepstra: a, pitch: 0 } : a;
  const right = Array.isArray(b) ? { cepstra: b, pitch: 0 } : b;
  return similarity(left.cepstra, right.cepstra) * pitchFactor(left.pitch, right.pitch);
}

const centroid = (vectors) => {
  const dims = vectors[0].cepstra.length;
  const sum = new Array(dims).fill(0);
  for (const vector of vectors) {
    for (let d = 0; d < dims; d += 1) sum[d] += vector.cepstra[d] / vectors.length;
  }
  const pitches = vectors.map((vector) => vector.pitch).filter((value) => value > 0).sort((x, y) => x - y);
  return {
    cepstra: l2(sum),
    pitch: pitches.length ? pitches[Math.floor(pitches.length / 2)] : 0,
    spread: vectors.reduce((total, vector) => total + (vector.spread || 0), 0) / vectors.length,
  };
};

const serialize = (print) =>
  JSON.stringify({
    v: 2,
    cepstra: print.cepstra.map((value) => Number(value.toFixed(6))),
    pitch: Number((print.pitch || 0).toFixed(3)),
    spread: Number((print.spread || 0).toFixed(4)),
  });

const parse = (raw) => {
  const value = JSON.parse(raw);
  return Array.isArray(value) ? { cepstra: value, pitch: 0 } : value;
};

/** Words only, lowercased, so "Call one oh one." and "call 101" compare by shape. */
const words = (text) =>
  String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);

/**
 * How much of the enrolled phrase the browser heard. Speech recognition is the
 * page's, not ours, so this is a sanity check on the attempt — the voiceprint is
 * what actually authorises. A missing transcript is not a failure.
 */
export function phraseMatch(heard, expected) {
  const want = words(expected);
  const got = words(heard);
  if (!want.length || !got.length) return null;
  const hits = want.filter((word) => got.includes(word)).length;
  return hits / want.length >= 0.6;
}

/* -------------------------------------------------------------- storage -- */

const rowFor = (accountId, extension) =>
  db_.get('SELECT * FROM voiceprints WHERE account_id = ? AND extension = ?', [accountId, String(extension)]);

const view = (row) =>
  row && {
    id: row.id,
    accountId: row.account_id,
    extension: row.extension,
    phrase: row.phrase || '',
    samples: row.samples ?? 0,
    threshold: row.threshold,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };

export const voiceprintFor = (accountId, extension) => view(rowFor(accountId, extension));

const record = (accountId, extension, outcome, score, detail) =>
  db_.run(
    'INSERT INTO voice_auth_events (id, account_id, extension, outcome, score, detail) VALUES (?, ?, ?, ?, ?, ?)',
    [newId('vae_'), accountId, String(extension), outcome, Number(score) || 0, String(detail || '').slice(0, 200)]
  );

/** Attempts in the last hour; a lockout is read from the log, not a counter. */
export function recentAttempts(accountId, extension) {
  return Number(
    db_.get(
      "SELECT COUNT(*) AS n FROM voice_auth_events WHERE account_id = ? AND extension = ? AND outcome IN ('pass', 'fail') AND at > ?",
      [accountId, String(extension), new Date(Date.now() - 3_600_000).toISOString()]
    )?.n || 0
  );
}

/**
 * Enroll (or re-enroll) a line.
 *
 * Two samples minimum: one recording is an anecdote, and the distance between
 * samples is the only evidence available that the embedding is stable. Samples
 * that do not agree with each other are refused before they become the reference
 * that every future check is measured against.
 */
export function enrollVoiceprint({ accountId, extension, phrase = '', wavs = [] }) {
  const clean = wavs.filter(Boolean);
  if (clean.length < 2) throw badRequest('Record the phrase at least twice so the voiceprint has something to check against');
  if (clean.length > 5) throw badRequest('At most five samples per enrollment');

  const embeddings = [];
  for (const wav of clean) embeddings.push(embeddingFromWav(wav));

  const center = centroid(embeddings);
  // Samples have to agree with each other before they can become the reference
  // every future check is measured against. Two different voices recorded as one
  // enrollment would otherwise produce a print nobody can match.
  const scores = embeddings.map((vector) => compare(vector, center));
  const consistency = Math.min(...scores);
  if (consistency < 0.75) {
    record(accountId, extension, 'enroll', consistency, 'samples disagree');
    throw badRequest(
      `The recordings do not sound like each other (closest match ${consistency.toFixed(2)}). Record them again in the same place, without background noise.`
    );
  }

  const existing = voiceprintFor(accountId, extension);
  const payload = serialize(center);
  const threshold = config.voice.threshold;
  if (existing) {
    db_.run(
      'UPDATE voiceprints SET phrase = ?, embedding = ?, samples = ?, threshold = ?, updated_at = ? WHERE id = ?',
      [String(phrase).slice(0, 120), payload, embeddings.length, threshold, now(), existing.id]
    );
  } else {
    db_.run(
      'INSERT INTO voiceprints (id, account_id, extension, phrase, embedding, samples, threshold) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [newId('vp_'), accountId, String(extension), String(phrase).slice(0, 120), payload, embeddings.length, threshold]
    );
  }
  record(accountId, extension, 'enroll', consistency, `${embeddings.length} sample(s)`);
  return {
    ...voiceprintFor(accountId, extension),
    consistency,
    scores: scores.map((score) => Number(score.toFixed(3))),
  };
}

export const deleteVoiceprint = (accountId, extension) =>
  db_.run('DELETE FROM voiceprints WHERE account_id = ? AND extension = ?', [accountId, String(extension)]).changes > 0;

/* --------------------------------------------------------------- tickets -- */

/**
 * A passed check is a ticket, not a token: single use, a few minutes, tied to
 * one account and one line. The softphone session consumes it, so replaying it
 * to mint a second session is not possible.
 */
const tickets = new Map();

const prune = () => {
  const at = Date.now();
  for (const [key, ticket] of tickets) if (ticket.expires < at) tickets.delete(key);
};

export function issueVoiceTicket(accountId, extension) {
  prune();
  const value = `vx_${createHash('sha256')
    .update(`${accountId}:${extension}:${now()}:${Math.random()}`)
    .digest('base64url')
    .slice(0, 32)}`;
  const expires = Date.now() + config.voice.ticketTtlSec * 1000;
  tickets.set(value, { accountId, extension: String(extension), expires });
  return { ticket: value, expiresIn: config.voice.ticketTtlSec };
}

export function takeVoiceTicket(value, { accountId, extension } = {}) {
  prune();
  const key = String(value || '');
  const ticket = tickets.get(key);
  if (!ticket) return false;
  tickets.delete(key);
  if (ticket.expires < Date.now()) return false;
  if (accountId && ticket.accountId !== accountId) return false;
  if (extension && ticket.extension !== String(extension)) return false;
  return true;
}

/* ---------------------------------------------------------------- verify -- */

/**
 * Check one recording against the enrolled print.
 *
 * Returns the score and a verdict; the caller decides what a pass is worth. A
 * failure is logged either way — repeated failures are what a lockout is made
 * of, and an operator debugging "my own voice will not work" needs the numbers.
 */
export function verifyVoiceprint({ accountId, extension, wav, heard = '' }) {
  const print = rowFor(accountId, extension);
  if (!print) throw notFound('This line has no voiceprint yet');
  const attempts = recentAttempts(accountId, extension);
  if (attempts >= config.voice.attemptsPerHour) {
    record(accountId, extension, 'refused', 0, `${attempts} attempts in the last hour`);
    throw tooMany('Too many voice checks on this line — wait a few minutes and try again');
  }

  const vector = embeddingFromWav(wav);
  const stored = parse(print.embedding);
  const score = compare(vector, stored);
  const phrase = phraseMatch(heard, print.phrase);
  const ok = score >= print.threshold && phrase !== false;

  record(accountId, extension, ok ? 'pass' : 'fail', score, phrase === false ? 'phrase did not match' : '');
  return {
    ok,
    score: Number(score.toFixed(3)),
    threshold: print.threshold,
    phraseMatch: phrase,
    // How far above or below the line the attempt landed: an operator tuning a
    // threshold should see the number, not just a refusal.
    margin: Number((score - print.threshold).toFixed(3)),
  };
}

/* ------------------------------------------------------------------ gate -- */

/** Is this line's session gated, and can it actually be opened? */
export function voiceGate(extension) {
  const required = !!extension?.voice_auth && config.voice.authEnabled;
  if (!required || !extension?.account_id) return { required: false, enrolled: false };
  const print = voiceprintFor(extension.account_id, extension.extension);
  return {
    required: true,
    enrolled: !!print,
    // A line that asked for a check but has no print would lock its owner out;
    // the gate treats "required, not enrolled" as open until enrollment happens.
    enforced: !!print,
    phrase: print?.phrase || '',
    updatedAt: print?.updatedAt || null,
  };
}

/** Enabling the check needs a print, or the line locks itself on the next call. */
export function assertCanRequireVoice(extension, enabled) {
  if (!enabled) return;
  if (!config.voice.authEnabled) throw forbidden('Voice authentication is switched off on this platform');
  if (!voiceprintFor(extension.account_id, extension.extension)) {
    throw badRequest('Enroll a voiceprint before requiring one');
  }
}

/** The switch is the owner of the line: only they may turn this on. */
export function requireVoiceAuth(account, extension) {
  if ((account?.account_kind || 'staff') === 'customer' && extension.account_id !== account.id) {
    throw forbidden('That line is not on your account');
  }
}
