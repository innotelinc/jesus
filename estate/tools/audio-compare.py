#!/usr/bin/env python3
"""
Does the audio the caller received actually match the audio the agent sent?

A call can "connect" and still carry noise: the transcript proves the agent
heard the caller and answered, but not that the answer arrived as speech. This
compares a recording taken at the far end (a probe's received RTP) with the
agent's own bot track and reports how strongly they line up.

The comparison is a normalised cross-correlation found through an FFT, so it
answers the question that matters — "is this the same sound, only later?" —
rather than "is there energy on the line". A garbled or codec-mismatched stream
decorrelates; a faithful one peaks sharply near 1.0.

Usage:
  python3 audio-compare.py <received.wav> <agent-track.wav> [--window 3]

Only numpy is needed. Exit 0 when the peak correlation clears the threshold,
1 otherwise, so it can gate a check.
"""
import argparse
import sys
import wave

import numpy as np

RATE = 8000


def read_wav(path):
    with wave.open(path) as w:
        rate = w.getframerate()
        channels = w.getnchannels()
        width = w.getsampwidth()
        raw = w.readframes(w.getnframes())
    if width != 2:
        raise SystemExit(f"{path}: expected 16-bit PCM, got {width * 8}-bit")
    data = np.frombuffer(raw, dtype='<i2').astype(np.float64) / 32768.0
    if channels > 1:
        data = data.reshape(-1, channels).mean(axis=1)
    return rate, data


def resample(data, rate, target=RATE):
    if rate == target:
        return data
    length = int(round(len(data) * target / rate))
    src = np.linspace(0, len(data) - 1, num=len(data))
    dst = np.linspace(0, len(data) - 1, num=length)
    return np.interp(dst, src, data)


def best_match(received, track, window_seconds):
    """Slide `track` over `received`; return (correlation, lag seconds, span)."""
    window = int(window_seconds * RATE)
    # A short, loud slice of the agent's track makes a better template than the
    # whole thing: silence inside it only dilutes the peak.
    if len(track) > window:
        energy = np.convolve(track**2, np.ones(window) / window, mode='valid')
        start = int(np.argmax(energy))
        template = track[start : start + window]
    else:
        start = 0
        template = track
    if not len(template):
        raise SystemExit('agent track is empty')

    template = template - template.mean()
    norm = np.linalg.norm(template)
    if norm == 0:
        raise SystemExit('agent track is silent — nothing to correlate')

    size = 1 << int(np.ceil(np.log2(len(received) + len(template))))
    corr = np.fft.irfft(np.fft.rfft(received, size) * np.conj(np.fft.rfft(template, size)))
    corr = corr[: len(received) - len(template) + 1]

    # Normalise by the local energy of the received signal so a loud passage
    # cannot win on volume alone.
    cum = np.concatenate([[0.0], np.cumsum(received**2)])
    energy = cum[len(template) :] - cum[: -len(template)]
    energy = np.sqrt(np.maximum(energy, 1e-12))
    score = corr / (energy * norm)
    lag = int(np.argmax(score))
    return float(score[lag]), lag / RATE, (start / RATE, (start + len(template)) / RATE)


def speech_seconds(data, threshold=0.01):
    """Count 20 ms frames above a quiet-room floor, to show the line carried speech."""
    frame = int(0.02 * RATE)
    frames = len(data) // frame
    if not frames:
        return 0.0, 0.0
    rms = np.sqrt((data[: frames * frame].reshape(frames, frame) ** 2).mean(axis=1))
    return float((rms > threshold).sum() * 0.02), float(rms.max())


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('received', help='audio recorded at the far end of the call')
    parser.add_argument('track', help="the agent's own bot track")
    parser.add_argument('--window', type=float, default=3.0, help='template length, seconds')
    parser.add_argument('--min', type=float, default=0.5, help='peak correlation to accept')
    args = parser.parse_args()

    rate, received = read_wav(args.received)
    track_rate, track = read_wav(args.track)
    received = resample(received, rate)
    track = resample(track, track_rate)

    speech, peak = speech_seconds(received)
    correlation, lag, span = best_match(received, track, args.window)

    print(f'received: {len(received) / RATE:.2f} s, speech-like {speech:.2f} s, peak {peak:.3f}')
    print(f'agent track: {len(track) / RATE:.2f} s')
    print(f'template: {span[1] - span[0]:.2f} s of the agent track from {span[0]:.2f} s')
    print(f'match: correlation {correlation:.3f} at +{lag:.2f} s')

    if correlation >= args.min:
        print('PASS — the caller heard the agent, not noise')
        return 0
    print(f'FAIL — peak correlation {correlation:.3f} is below {args.min}')
    return 1


if __name__ == '__main__':
    sys.exit(main())
