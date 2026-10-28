#!/usr/bin/env python3
"""Benchmark the TTS engines this stack can serve, from inside the shim.

The question this answers is not "how fast is the model" but "can the caller
hear it": time to first audio (TTFA), total wall time to synthesize, and the
real-time factor (RTF = wall time / audio duration). An engine with RTF > 1
cannot keep up with playback, however good it sounds.

Usage (from the host):
    docker exec tts-shim python /app/bench_tts.py --target tts-shim
    docker exec tts-shim python /app/bench_tts.py --target speaches --voice af_heart
    docker exec tts-shim python /app/bench_tts.py --target kokoro --voice af_heart
"""

from __future__ import annotations

import argparse
import asyncio
import statistics
import time
import uuid

import httpx

RATE = 24000  # every target is asked for 24 kHz s16le mono PCM

LINES = {
    "short": "Could you tell me your name?",
    "medium": "Thanks. I have your start date as the third of November, is that right?",
    "greeting": (
        "Hello, and thanks for calling. My name is Ava. I would like to ask you a "
        "few quick questions about the role you applied for, and it should take "
        "about five minutes. Is now still a good time to talk?"
    ),
}

TARGETS = {
    # name: (base_url, model, default_voice)
    "tts-shim": ("http://127.0.0.1:8880", "piper", "en_US-amy-medium"),
    "speaches": ("http://speaches:8000", "speaches-ai/Kokoro-82M-v1.0-ONNX", "af_heart"),
    "kokoro": ("http://kokoro-fastapi:8880", "kokoro", "af_heart"),
}


async def one(client: httpx.AsyncClient, url: str, model: str, voice: str, text: str):
    payload = {
        "input": text,
        "model": model,
        "voice": voice,
        "response_format": "pcm",
    }
    started = time.perf_counter()
    first = None
    total = 0
    async with client.stream("POST", url, json=payload) as response:
        if response.status_code != 200:
            body = (await response.aread())[:200]
            raise SystemExit(f"HTTP {response.status_code}: {body!r}")
        async for chunk in response.aiter_bytes():
            if not chunk:
                continue
            if first is None:
                first = time.perf_counter() - started
            total += len(chunk)
    elapsed = time.perf_counter() - started
    duration = total / (RATE * 2)
    return first or 0.0, elapsed, duration


async def run(
    target: str,
    voice: str,
    repeats: int,
    lines: list[str],
    cold: bool,
    url_override: str,
    model_override: str,
) -> int:
    base, model, default_voice = TARGETS[target]
    if url_override:
        base = url_override.rstrip("/")
    model = model_override or model
    voice = voice or default_voice
    url = f"{base}/v1/audio/speech"
    print(f"target={target} url={url} model={model} voice={voice}")
    async with httpx.AsyncClient(timeout=httpx.Timeout(300.0, connect=5.0)) as client:
        for label in lines:
            text = LINES[label]
            # Warm-up (model load, voice pack, thread pools) is not what a
            # caller waits for on the tenth sentence, but it is on the first.
            ttfas, totals, rtfs = [], [], []
            for i in range(repeats):
                # --cold suffixes every probe so the shim's audio cache cannot
                # answer it: that is the synthesis path a caller actually waits
                # on for new text. Without it, all but the first repeat are hits
                # (~20 ms) and the numbers say nothing about the engine.
                probe = f"{text} (probe {uuid.uuid4().hex[:8]})" if cold else text
                first, elapsed, duration = await one(client, url, model, voice, probe)
                ttfas.append(first)
                totals.append(elapsed)
                rtfs.append(elapsed / duration if duration else 0.0)
            print(
                f"  {label:<8} audio={duration:5.2f}s  "
                f"ttfa={statistics.median(ttfas):5.2f}s (min {min(ttfas):.2f})  "
                f"wall={statistics.median(totals):5.2f}s  RTF={statistics.median(rtfs):4.2f}"
            )
    return 0


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--target", choices=sorted(TARGETS), default="tts-shim")
    parser.add_argument("--voice", default="")
    parser.add_argument("--url", default="", help="override the target base URL")
    parser.add_argument(
        "--model",
        default="",
        help="override the model field (the shim's engine selector: `kokoro`/`piper`)",
    )
    parser.add_argument("--repeats", type=int, default=3)
    parser.add_argument(
        "--cold",
        action="store_true",
        help="make every probe unique so the shim cache misses (synthesis latency)",
    )
    parser.add_argument(
        "--lines",
        default="short,medium,greeting",
        help="comma-separated subset of: " + ",".join(LINES),
    )
    args = parser.parse_args()
    lines = [l.strip() for l in args.lines.split(",") if l.strip() in LINES]
    return asyncio.run(
        run(
            args.target,
            args.voice,
            args.repeats,
            lines,
            args.cold,
            args.url,
            args.model,
        )
    )


if __name__ == "__main__":
    raise SystemExit(main())
