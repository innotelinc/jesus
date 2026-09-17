"""Capstone streaming-TTS shim — one OpenAI-compatible door in front of N engines.

Why this exists
───────────────
dograh's ``SpeachesTTSService`` (pipecat) dials an OpenAI-compatible
``POST {base_url}/audio/speech`` and reads raw PCM off the response
(``response_format: "pcm"``, mono, 24 kHz — see
``dograh/upstream/pipecat/src/pipecat/services/speaches/tts.py``). That single
contract is what makes this shim possible without patching the agent at all: it
speaks the same protocol, and everything below the surface is ours.

Three things sit behind the door, and only the first is about the model:

1. **The same audio twice is not synthesized twice.** Interview agents replay a
   fixed script — questions, prompts, transfer lines, goodbyes — on every call.
   ``audio_file_cache.py`` upstream caches recordings and ambient noise only, so
   every one of those lines was re-synthesized from scratch. This shim caches the
   synthesized PCM keyed on (engine, voice, speed, text), which costs a hash and a
   file read instead of a full CPU synthesis.

2. **Engines are pluggable, and A/B-selectable per request.** The engine is chosen
   by the request's ``model`` field (or an ``X-TTS-Engine`` header), so swapping or
   A/B-testing an engine is a configuration change in dograh — never a code change
   in the agent. ``/v1/models`` advertises what is loaded.

3. **It measures itself.** Every request records time-to-first-audio, synthesis
   time and cache outcome on ``/metrics``. That is deliberate: the SigNoz pipeline
   dashboard read TTS TTFB out of a *span attribute* (``metrics.ttfb``), which no
   longer exists once spans stop being stored, so TTS latency is measured here
   instead — at the process that actually knows it.

No GPU: the engines wired in below (Kokoro-82M, Piper) are the two that hold
real-time factor on CPU. Anything larger belongs to the GPU phase.
"""

from __future__ import annotations

import asyncio
import hashlib
import os
import threading
import time
from contextlib import asynccontextmanager
from pathlib import Path
from typing import AsyncIterator

import httpx
import numpy as np
from fastapi import FastAPI, Header, HTTPException, Request, Response
from fastapi.responses import StreamingResponse
from prometheus_client import (
    CONTENT_TYPE_LATEST,
    Counter,
    Gauge,
    Histogram,
    generate_latest,
)

# ── Configuration ─────────────────────────────────────────────────────────────

CACHE_DIR = Path(os.getenv("TTS_SHIM_CACHE_DIR", "/var/cache/tts-shim"))
CACHE_MAX_BYTES = int(os.getenv("TTS_SHIM_CACHE_MAX_BYTES", str(512 * 1024 * 1024)))
CACHE_ENABLED = os.getenv("TTS_SHIM_CACHE_ENABLED", "true").lower() != "false"

# Everything emitted is s16le mono at this rate, which is what pipecat's
# SpeachesTTSService is constructed with (sample_rate=24000).
TARGET_RATE = int(os.getenv("TTS_SHIM_SAMPLE_RATE", "24000"))
CHUNK_BYTES = int(os.getenv("TTS_SHIM_CHUNK_BYTES", "8192"))

KOKORO_URL = os.getenv("TTS_SHIM_KOKORO_URL", "http://kokoro-fastapi:8880").rstrip("/")
KOKORO_DEFAULT_VOICE = os.getenv("TTS_SHIM_KOKORO_VOICE", "af_heart")

# Piper is optional: the engine only registers when the package imports AND a
# voice model is configured. A shim with no Piper is still a working shim.
PIPER_VOICE = os.getenv("TTS_SHIM_PIPER_VOICE", "").strip()
PIPER_VOICE_DIR = Path(os.getenv("TTS_SHIM_PIPER_VOICE_DIR", "/opt/piper-voices"))

_ENGINES_RAW = os.getenv("TTS_SHIM_ENGINES", "kokoro")
DEFAULT_ENGINE = os.getenv("TTS_SHIM_DEFAULT_ENGINE", "").strip()

# ── Metrics ───────────────────────────────────────────────────────────────────

REQUESTS = Counter(
    "tts_shim_requests_total",
    "TTS requests handled, by engine and outcome.",
    ["engine", "outcome"],
)
CACHE_LOOKUPS = Counter(
    "tts_shim_cache_lookups_total",
    "Cache lookups, by result. 'hit' means no synthesis was performed.",
    ["result"],
)
TTFA = Histogram(
    "tts_shim_ttfa_seconds",
    "Time from request receipt to the first audio byte streamed to the client.",
    ["engine", "cache"],
    buckets=(0.01, 0.025, 0.05, 0.075, 0.1, 0.15, 0.2, 0.3, 0.5, 0.75, 1, 1.5, 2, 3, 5, 10),
)
SYNTHESIS = Histogram(
    "tts_shim_synthesis_seconds",
    "Wall time spent inside the engine (excludes a cache hit).",
    ["engine"],
    buckets=(0.025, 0.05, 0.1, 0.2, 0.3, 0.5, 0.75, 1, 1.5, 2, 3, 5, 10, 20),
)
AUDIO_BYTES = Counter(
    "tts_shim_audio_bytes_total",
    "PCM bytes streamed to clients, by engine.",
    ["engine"],
)
CACHE_BYTES = Gauge("tts_shim_cache_bytes", "Bytes currently held in the audio cache.")
INFLIGHT = Gauge("tts_shim_inflight", "TTS requests currently being synthesized.")

CACHE_VERSION = "v1"  # bump to invalidate every entry after a format change

# One loaded Piper voice, one synthesis at a time: the ONNX session is not
# documented as thread-safe, and serializing is cheap next to reloading it.
_PIPER_LOCK = threading.Lock()


# ── Engines ───────────────────────────────────────────────────────────────────


class EngineUnavailable(RuntimeError):
    """Raised when a request names an engine that is not loaded."""


class Engine:
    """A PCM source. ``stream()`` yields s16le mono chunks at TARGET_RATE."""

    name: str

    def available(self) -> bool:  # pragma: no cover - trivial
        return True

    async def stream(self, text: str, voice: str, speed: float) -> AsyncIterator[bytes]:
        raise NotImplementedError

    def describe(self) -> dict:
        return {"id": self.name}


class KokoroEngine(Engine):
    """Kokoro-82M over kokoro-fastapi (already an OpenAI-compatible service).

    The shim is a proxy on this path, not a model host: kokoro-fastapi owns the
    model, the ONNX runtime and the streaming, and it is already tuned for CPU
    (see the ``kokoro`` service's OMP/MKL thread settings in docker-compose.yml).
    """

    name = "kokoro"

    def __init__(self, url: str, default_voice: str) -> None:
        self.url = url
        self.default_voice = default_voice
        self._client: httpx.AsyncClient | None = None

    async def startup(self) -> None:
        self._client = httpx.AsyncClient(timeout=httpx.Timeout(120.0, connect=5.0))

    async def shutdown(self) -> None:
        if self._client is not None:
            await self._client.aclose()

    async def healthy(self) -> bool:
        if self._client is None:
            return False
        try:
            r = await self._client.get(f"{self.url}/health", timeout=3.0)
            return r.status_code < 500
        except Exception:
            return False

    async def stream(self, text: str, voice: str, speed: float) -> AsyncIterator[bytes]:
        if self._client is None:
            raise EngineUnavailable("kokoro engine not started")
        payload = {
            "model": "kokoro",
            "input": text,
            # Kokoro's own voice ids (af_heart, am_michael, …). A caller that
            # sends piper-style ids falls back to the configured default.
            "voice": voice or self.default_voice,
            "response_format": "pcm",
            "speed": speed or 1.0,
        }
        async with self._client.stream(
            "POST", f"{self.url}/v1/audio/speech", json=payload
        ) as response:
            if response.status_code != 200:
                body = (await response.aread())[:400]
                raise EngineUnavailable(
                    f"kokoro upstream {response.status_code}: {body!r}"
                )
            async for chunk in response.aiter_bytes():
                if chunk:
                    yield chunk


class PiperEngine(Engine):
    """Piper — small ONNX voices, CPU-native, the low-latency fast path.

    In-process, deliberately. The obvious implementation shells out to the
    `piper` CLI per request, and that is what this started as — measured, it was
    ~1.78 s to first audio, because *loading the voice and the espeak phonemizer
    costs more than synthesizing the sentence does*. Paying that per request
    makes the engine look slow when the model is not. So the voice is loaded
    once at startup and `PiperVoice.synthesize()` streams `AudioChunk`s here,
    which is the only way the model's actual speed shows up.

    Synthesis is synchronous and CPU-bound, so it runs on a worker thread that
    feeds an asyncio queue; `_PIPER_LOCK` serializes concurrent requests through
    the one loaded voice (the ONNX session is not documented as thread-safe, and
    a second concurrent call would otherwise race it).

    Voices are 16 kHz or 22.05 kHz, so output is resampled to TARGET_RATE. The
    resampler is stateful (`soxr.ResampleStream`) so chunk boundaries do not
    produce clicks; without soxr it falls back to per-chunk linear
    interpolation, which is audibly rougher and only used if soxr is absent.
    """

    name = "piper"

    def __init__(self, voice: str, voice_dir: Path) -> None:
        self.voice = voice
        self.voice_dir = voice_dir
        self._soxr = None
        self._voice = None  # piper.PiperVoice, loaded once at startup
        self._model: Path | None = None
        self._rate: int | None = None

    def available(self) -> bool:
        return self._voice is not None

    async def startup(self) -> None:
        try:
            import soxr

            self._soxr = soxr
        except Exception:
            self._soxr = None

        if not self.voice:
            return
        candidate = Path(self.voice)
        if not candidate.is_absolute():
            candidate = self.voice_dir / self.voice
        if not candidate.suffix:
            candidate = candidate.with_suffix(".onnx")
        if not candidate.exists():
            return

        # Blocking load (hundreds of ms) — keep it off the event loop.
        self._voice = await asyncio.to_thread(self._load, candidate)
        if self._voice is not None:
            self._model = candidate
            self._rate = self._read_rate(candidate)

    @staticmethod
    def _load(model: Path):
        try:
            from piper import PiperVoice

            return PiperVoice.load(str(model), use_cuda=False)
        except Exception:
            return None

    @staticmethod
    def _read_rate(model: Path) -> int:
        """Piper stores the voice's sample rate in a sibling .json."""
        import json

        meta = model.with_suffix(".onnx.json")
        if meta.exists():
            try:
                return int(json.loads(meta.read_text())["audio"]["sample_rate"])
            except Exception:
                pass
        return 22050  # piper's most common voice rate

    def _resampler(self):
        if self._rate == TARGET_RATE:
            return None
        if self._soxr is not None:
            return self._soxr.ResampleStream(
                self._rate, TARGET_RATE, 1, dtype="int16", quality="HQ"
            )
        return "linear"

    @staticmethod
    def _linear(chunk: bytes, in_rate: int) -> bytes:
        src = np.frombuffer(chunk, dtype="<i2")
        if src.size == 0:
            return b""
        count = max(1, int(round(src.size * TARGET_RATE / in_rate)))
        idx = np.linspace(0, src.size - 1, count)
        return np.interp(idx, np.arange(src.size), src.astype(np.float32)).astype("<i2").tobytes()

    async def stream(self, text: str, voice: str, speed: float) -> AsyncIterator[bytes]:
        if not self.available():
            raise EngineUnavailable("piper engine not available (no voice model)")

        loop = asyncio.get_running_loop()
        queue: asyncio.Queue = asyncio.Queue(maxsize=16)
        done = object()

        def worker() -> None:
            """Blocking synthesis on a real thread; hand chunks back as they land."""
            try:
                from piper import SynthesisConfig

                syn = SynthesisConfig(
                    length_scale=1.0 / float(speed) if speed else 1.0
                )
                with _PIPER_LOCK:
                    for chunk in self._voice.synthesize(text, syn_config=syn):
                        raw = chunk.audio_int16_bytes
                        if raw:
                            asyncio.run_coroutine_threadsafe(queue.put(raw), loop).result()
            except Exception as exc:  # surfaced to the client as a 502
                asyncio.run_coroutine_threadsafe(queue.put(exc), loop).result()
            finally:
                asyncio.run_coroutine_threadsafe(queue.put(done), loop).result()

        fut = loop.run_in_executor(None, worker)
        resampler = self._resampler()
        try:
            while True:
                item = await queue.get()
                if item is done:
                    break
                if isinstance(item, Exception):
                    raise EngineUnavailable(f"piper synthesis failed: {item}")
                if resampler is None:
                    yield item
                elif resampler == "linear":
                    out = self._linear(item, self._rate or 22050)
                    if out:
                        yield out
                else:
                    out = resampler.resample_chunk(
                        np.frombuffer(item, dtype="<i2"), last=False
                    )
                    if out is not None and len(out):
                        yield out.tobytes()
            # Flush the resampler's tail so the last few ms are not lost.
            if resampler is not None and resampler != "linear":
                tail = resampler.resample_chunk(np.zeros(0, dtype="<i2"), last=True)
                if tail is not None and len(tail):
                    yield tail.tobytes()
        finally:
            await fut

    def describe(self) -> dict:
        return {
            "id": self.name,
            "voice": self.voice,
            "rate": self._rate,
            "resampled_to": TARGET_RATE,
            "mode": "in-process",
        }


class Registry:
    def __init__(self) -> None:
        self._engines: dict[str, Engine] = {}

    def add(self, engine: Engine) -> None:
        self._engines[engine.name] = engine

    async def startup(self) -> None:
        for engine in self._engines.values():
            fn = getattr(engine, "startup", None)
            if fn is not None:
                await fn()

    def names(self) -> list[str]:
        return [n for n, e in self._engines.items() if e.available()]

    def all_names(self) -> list[str]:
        return list(self._engines)

    @property
    def default(self) -> str:
        requested = DEFAULT_ENGINE or _ENGINES_RAW.split(",")[0].strip()
        if requested in self._engines and self._engines[requested].available():
            return requested
        available = self.names()
        if not available:
            raise EngineUnavailable("no TTS engine is available")
        return available[0]

    def resolve(self, requested: str | None) -> tuple[str, Engine]:
        """Map a request's engine hint to a loaded engine.

        Accepts an engine id (``kokoro``) or a model string that names one
        (``kokoro``, ``kokoro:af_heart``) so the same field dograh already sends
        can select the engine.
        """
        if requested:
            head = requested.split(":", 1)[0].split("@", 1)[0].strip().lower()
            engine = self._engines.get(head)
            if engine is not None and engine.available():
                return head, engine
            # An unknown engine must not silently fall back: that would make an
            # A/B test look like it worked when both arms were the same engine.
            if head in self._engines:
                raise EngineUnavailable(f"engine '{head}' is not available")
        name = self.default
        return name, self._engines[name]


REGISTRY = Registry()


# ── Cache ─────────────────────────────────────────────────────────────────────


def cache_key(engine: str, voice: str, speed: float, text: str) -> str:
    material = f"{CACHE_VERSION}|{engine}|{voice}|{speed:.3f}|{text}"
    return hashlib.sha256(material.encode("utf-8")).hexdigest()


def cache_path(key: str) -> Path:
    return CACHE_DIR / key[:2] / f"{key}.pcm"


def cache_get(key: str) -> Path | None:
    path = cache_path(key)
    if not CACHE_ENABLED or not path.exists() or path.stat().st_size == 0:
        return None
    os.utime(path, None)  # LRU touch
    return path


def cache_put(key: str, data: bytes) -> None:
    """Write a completed synthesis to the cache, then enforce the size cap."""
    if not CACHE_ENABLED or not data:
        return
    path = cache_path(key)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_bytes(data)
    tmp.replace(path)
    evict()


def evict() -> None:
    if not CACHE_ENABLED:
        return
    files = [p for p in CACHE_DIR.rglob("*.pcm") if p.is_file()]
    total = sum(p.stat().st_size for p in files)
    CACHE_BYTES.set(total)
    if total <= CACHE_MAX_BYTES:
        return
    for path in sorted(files, key=lambda p: p.stat().st_mtime):
        try:
            size = path.stat().st_size
            path.unlink()
            total -= size
        except OSError:
            continue
        if total <= CACHE_MAX_BYTES:
            break
    CACHE_BYTES.set(total)


# ── App ───────────────────────────────────────────────────────────────────────


@asynccontextmanager
async def lifespan(app: FastAPI):
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    REGISTRY.add(KokoroEngine(KOKORO_URL, KOKORO_DEFAULT_VOICE))
    REGISTRY.add(PiperEngine(PIPER_VOICE, PIPER_VOICE_DIR))
    await REGISTRY.startup()
    evict()
    yield


app = FastAPI(title="Capstone TTS shim", version="1.0.0", lifespan=lifespan)


def _float(value, default: float) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


async def _stream_response(path: Path, engine_name: str) -> AsyncIterator[bytes]:
    with path.open("rb") as fh:
        while True:
            chunk = fh.read(CHUNK_BYTES)
            if not chunk:
                break
            AUDIO_BYTES.labels(engine_name).inc(len(chunk))
            yield chunk


@app.get("/health")
async def health() -> dict:
    engines = REGISTRY.all_names()
    kokoro = REGISTRY._engines.get("kokoro")
    upstream = {}
    if isinstance(kokoro, KokoroEngine):
        upstream["kokoro"] = await kokoro.healthy()
    return {
        "status": "ok" if REGISTRY.names() else "degraded",
        "engines": REGISTRY.names(),
        "default_engine": REGISTRY.default if REGISTRY.names() else None,
        "target_sample_rate": TARGET_RATE,
        "cache_enabled": CACHE_ENABLED,
        "upstream": upstream,
    }


@app.get("/v1/models")
async def models() -> dict:
    return {
        "object": "list",
        "data": [
            {"id": name, "object": "model", "owned_by": "capstone"}
            for name in REGISTRY.names()
        ],
    }


@app.get("/metrics")
async def metrics() -> Response:
    return Response(generate_latest(), media_type=CONTENT_TYPE_LATEST)


@app.post("/v1/audio/speech")
async def speech(
    request: Request,
    x_tts_engine: str | None = Header(default=None, alias="X-TTS-Engine"),
):
    """OpenAI-compatible speech synthesis, streamed as raw PCM.

    Body: ``{input, model, voice, response_format, speed?}`` — the shape
    pipecat's SpeachesTTSService sends. ``model`` selects the engine.
    """
    try:
        body = await request.json()
    except Exception:
        raise HTTPException(status_code=400, detail="request body must be JSON")

    text = (body.get("input") or "").strip()
    if not text:
        raise HTTPException(status_code=400, detail="'input' is required")

    voice = body.get("voice") or ""
    speed = _float(body.get("speed"), 1.0)
    fmt = (body.get("response_format") or "pcm").lower()
    if fmt not in ("pcm", "s16le", "raw"):
        raise HTTPException(
            status_code=400,
            detail=f"response_format '{fmt}' is not supported; this shim streams raw PCM (s16le mono)",
        )

    try:
        engine_name, engine = REGISTRY.resolve(x_tts_engine or body.get("model"))
    except EngineUnavailable as exc:
        REQUESTS.labels("unknown", "error").inc()
        raise HTTPException(status_code=503, detail=str(exc))

    started = time.perf_counter()
    key = cache_key(engine_name, voice, speed, text)

    try:
        hit = cache_get(key)
    except OSError:
        hit = None  # an unreadable cache entry must never fail the request

    if hit is not None:
        CACHE_LOOKUPS.labels("hit").inc()
        REQUESTS.labels(engine_name, "hit").inc()
        TTFA.labels(engine_name, "hit").observe(time.perf_counter() - started)
        return StreamingResponse(
            _stream_response(hit, engine_name),
            media_type="audio/pcm",
            headers={
                "X-TTS-Engine": engine_name,
                "X-TTS-Cache": "hit",
                "X-Sample-Rate": str(TARGET_RATE),
            },
        )

    CACHE_LOOKUPS.labels("miss").inc()

    async def generate() -> AsyncIterator[bytes]:
        """Stream engine audio to the client while teeing it into the cache.

        Synthesis time and TTFB are only known once the engine produces its
        first byte, so they are recorded here — the endpoint function itself has
        already returned by the time this generator runs.
        """
        first = True
        collected = bytearray()
        synth_start = time.perf_counter()
        INFLIGHT.inc()
        try:
            async for chunk in engine.stream(text, voice, speed):
                if not chunk:
                    continue
                if first:
                    SYNTHESIS.labels(engine_name).observe(time.perf_counter() - synth_start)
                    TTFA.labels(engine_name, "miss").observe(time.perf_counter() - started)
                    first = False
                collected.extend(chunk)
                AUDIO_BYTES.labels(engine_name).inc(len(chunk))
                yield chunk
            if first:
                # Nothing was produced: count it as a failure so an engine that
                # dies mid-stream is visible rather than merely absent.
                REQUESTS.labels(engine_name, "error").inc()
            else:
                REQUESTS.labels(engine_name, "ok").inc()
                cache_put(key, bytes(collected))
        except EngineUnavailable:
            REQUESTS.labels(engine_name, "error").inc()
            raise
        finally:
            INFLIGHT.dec()

    return StreamingResponse(
        generate(),
        media_type="audio/pcm",
        headers={
            "X-TTS-Engine": engine_name,
            "X-TTS-Cache": "miss",
            "X-Sample-Rate": str(TARGET_RATE),
        },
    )


@app.post("/v1/audio/speech/cache/clear")
async def cache_clear() -> dict:
    """Drop every cached clip. Handy after changing voice packs."""
    removed = 0
    if CACHE_DIR.exists():
        for path in CACHE_DIR.rglob("*.pcm"):
            try:
                path.unlink()
                removed += 1
            except OSError:
                continue
    CACHE_BYTES.set(0)
    return {"removed": removed}
