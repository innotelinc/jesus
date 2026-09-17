# Capstone TTS shim

One OpenAI-compatible door in front of the stack's speech engines. dograh's
`speaches` TTS provider — pipecat's `SpeachesTTSService`, see
`dograh/upstream/pipecat/src/pipecat/services/speaches/tts.py` — dials
`POST {base_url}/audio/speech` and reads raw PCM off the response body
(`response_format: "pcm"`, mono, 24 kHz). This shim speaks exactly that contract,
so pointing dograh at it is a **model-configuration change and not a fork
patch**.

Three things sit behind the door, and only the first is about the model:

1. **The same audio twice is not synthesized twice.** Interview agents replay a
   fixed script — questions, prompts, transfer lines, goodbyes — on every call,
   and upstream's own `audio_file_cache.py` covers recordings and ambient noise
   only, so every one of those lines was re-synthesized from scratch. The shim
   caches the synthesized PCM keyed on `(engine, voice, speed, text)`, which
   costs a hash and a file read instead of a full CPU synthesis.
2. **Engines are pluggable and A/B-selectable per request.** The engine comes
   from the request's `model` field (or an `X-TTS-Engine` header), so swapping or
   A/B-testing an engine is a configuration change in dograh, never a code change
   in the agent. `GET /v1/models` advertises what is actually loaded.
3. **It measures itself.** Every request records time-to-first-audio, synthesis
   time and cache outcome on `/metrics`. That is deliberate: the old pipeline
   dashboard read TTS TTFB out of a span *attribute* (`metrics.ttfb`), which
   stops existing once spans are not stored, so TTS latency is measured here —
   at the process that actually knows it. See
   [`../grafana/dashboards/pipeline-latency.json`](../grafana/dashboards/pipeline-latency.json).

No GPU: the engines wired in below (Kokoro-82M, Piper) are the two that hold
real-time factor on CPU. Anything larger belongs to the GPU phase.

## Endpoints

| Endpoint | Purpose |
|---|---|
| `POST /v1/audio/speech` | The OpenAI-compatible synthesis call. Body: `{input, model, voice, response_format, speed?}`; `response_format` must be `pcm`, `s16le` or `raw` (anything else is a 400 — this shim streams PCM only). |
| `GET /v1/models` | The loaded engines, as OpenAI model ids. |
| `GET /health` | `status`, loaded engines, default engine, sample rate, cache flag, and the Kokoro upstream's own health. |
| `GET /metrics` | Prometheus text format (see *Metrics*). |
| `POST /v1/audio/speech/cache/clear` | Drops every cached clip. Handy after changing voice packs. Returns `{"removed": N}`. |

Every response from `/v1/audio/speech` carries `X-TTS-Engine` (which engine
served it), `X-TTS-Cache` (`hit`/`miss`) and `X-Sample-Rate` (`24000`). Bodies are
`audio/pcm`, streamed.

**Engine selection.** `model` (or `X-TTS-Engine`, which wins) takes an engine id
(`kokoro`) or an id plus a voice (`kokoro:af_heart`, `piper@en_US-amy-medium`).
An engine that is *known but unavailable* — `piper` with no voice model
configured — returns **503 rather than silently falling back**, because a
fallback would make an A/B test look like it worked when both arms were the same
engine. With no hint at all, `TTS_SHIM_DEFAULT_ENGINE` decides, else the first
entry of `TTS_SHIM_ENGINES` that is available.

## Engines

| Engine | What it is | Notes |
|---|---|---|
| `kokoro` | Kokoro-82M over `kokoro-fastapi` | A **proxy**, not a model host: kokoro-fastapi owns the model, the ONNX runtime and the streaming, and the `kokoro` compose service is already tuned for CPU (OMP/MKL thread settings). Voices are Kokoro's own ids (`af_heart`, `am_michael`, …); a piper-style voice name falls back to `TTS_SHIM_KOKORO_VOICE`. |
| `piper` | Local ONNX voices, in-process | The low-latency fast path, and **optional**: it registers only when the package imports *and* a voice model is configured. Voice packs live on the `tts_piper_voices` volume, not in the image, so adding a voice is a data decision rather than a rebuild. |

Piper is deliberately in-process. The obvious implementation shells out to the
`piper` CLI per request, and that is what this started as — measured, it was
**~1.78 s to first audio**, because loading the voice and the espeak phonemizer
costs more than synthesizing the sentence does. So the voice is loaded once at
startup and `PiperVoice.synthesize()` streams chunks instead. Synthesis is
synchronous and CPU-bound, so it runs on a worker thread feeding an asyncio
queue, with a lock serializing requests through the one loaded voice (the ONNX
session is not documented as thread-safe). Voices are 16 kHz or 22.05 kHz, so
output is resampled to `TTS_SHIM_SAMPLE_RATE`; the resampler is stateful
(`soxr.ResampleStream`) so chunk boundaries do not click, and it falls back to
per-chunk linear interpolation only when soxr is absent (audibly rougher).

## Configuration

Compose passes the ones marked *compose*; the rest have the defaults below and
only need setting when you change the behaviour.

| Variable | Default | Meaning |
|---|---|---|
| `TTS_SHIM_ENGINES` *(compose)* | `kokoro` | Comma-separated engine list. The first available entry is the default when `TTS_SHIM_DEFAULT_ENGINE` is empty. |
| `TTS_SHIM_DEFAULT_ENGINE` *(compose)* | *(empty)* | Engine used when a request names none. |
| `TTS_SHIM_KOKORO_URL` *(compose)* | `http://kokoro-fastapi:8880` | Kokoro upstream — a compose service name on `interview-net`. |
| `TTS_SHIM_KOKORO_VOICE` | `af_heart` | Voice when the request sends none (or a non-Kokoro id). |
| `TTS_SHIM_PIPER_VOICE` *(compose)* | *(empty)* | Piper voice file or id; empty disables the engine. |
| `TTS_SHIM_PIPER_VOICE_DIR` | `/opt/piper-voices` | Where voice packs are mounted. |
| `TTS_SHIM_CACHE_ENABLED` *(compose)* | `true` | `false` disables both lookup and write. |
| `TTS_SHIM_CACHE_MAX_BYTES` *(compose)* | `536870912` (512 MiB) | Eviction cap; oldest entries by mtime go first. |
| `TTS_SHIM_CACHE_DIR` | `/var/cache/tts-shim` | Where clips land (`<2 hex>/<sha256>.pcm`). |
| `TTS_SHIM_SAMPLE_RATE` *(compose)* | `24000` | Output rate; matches what pipecat constructs the service with. |
| `TTS_SHIM_CHUNK_BYTES` | `8192` | Streaming chunk size. |

Two knobs are worth knowing about the cache: `CACHE_VERSION` in `app.py` is part
of every key, so bumping it invalidates the whole cache after a format change,
and eviction is oldest-first by mtime with `os.utime` touching an entry on every
hit (a real LRU, not a random trim).

## Running it

It is a service in the main compose, so it starts with the stack:

```bash
docker compose up -d tts-shim
docker compose logs -f tts-shim
curl -s http://127.0.0.1:8881/health         # host mode: the shim is on 8881
```

The container listens on **8880** (the port `kokoro-fastapi` uses upstream, so
the same client code works against either) and the compose mapping publishes it
on **127.0.0.1:8881** so the two can coexist. Loopback-only, like every other
door in this stack.

Piper, with a voice fetch — the voice lands on the `tts_piper_voices` volume:

```bash
docker exec tts-shim python -m piper.download_voices en_US-amy-medium
# then in .env: TTS_SHIM_PIPER_VOICE=en_US-amy-medium  (and keep "piper" listed
# in TTS_SHIM_ENGINES if you want the request to be able to select it)
docker compose up -d tts-shim
```

Build without Piper at all (smaller image, faster build):

```bash
docker compose build --build-arg WITH_PIPER=0 tts-shim
```

### Pointing dograh at it

dograh runs in host network mode, so from its side the shim is on the host's
loopback port, and the provider is the one it already has — `speaches` — with a
different base URL. In the dograh UI's model configuration (or the workflow's
TTS settings):

```
provider  = speaches
base_url  = http://127.0.0.1:8881/v1     # host mode; http://tts-shim:8880/v1 from a container on interview-net
model     = kokoro                       # or: piper — this is what selects the engine
voice     = af_heart                     # any Kokoro voice; ignored/fallback for piper
```

Nothing else changes: the request/response contract is the same one
`SpeachesTTSService` already speaks. To A/B an engine, change `model` (or set
`X-TTS-Engine` on the request) and compare the **TTS time to first audio (shim)**
and **Synthesis time and spend (shim)** panels — both are labelled by engine, so
the two arms are visible side by side.

Kokoro can still be dialled directly on `127.0.0.1:8880` for a comparison run;
what you give up is the cache, the metrics and the second engine, and what you
keep is one less hop.

## Metrics

Scraped by the `prometheus` service (`tts-shim:8880`) and charted in the
pipeline-latency dashboard:

| Metric | Type | Labels | Meaning |
|---|---|---|---|
| `tts_shim_requests_total` | counter | `engine`, `outcome` (`ok`/`hit`/`error`) | Requests handled. An engine that produces no audio at all counts as `error` rather than being merely absent. |
| `tts_shim_cache_lookups_total` | counter | `result` (`hit`/`miss`) | Cache lookups; the hit rate panel is this over its own sum. |
| `tts_shim_ttfa_seconds` | histogram | `engine`, `cache` | Request receipt → first audio byte streamed. |
| `tts_shim_synthesis_seconds` | histogram | `engine` | Wall time inside the engine (not observed on a cache hit). |
| `tts_shim_audio_bytes_total` | counter | `engine` | PCM bytes streamed to clients. |
| `tts_shim_cache_bytes` | gauge | — | Bytes currently held by the cache; set on every eviction pass. |
| `tts_shim_inflight` | gauge | — | Requests being synthesized right now. |

## Files

| File | What it is |
|---|---|
| `app.py` | The whole shim: engines, cache, endpoints, metrics. |
| `Dockerfile` | CPU-only image; Piper is installed best-effort and can be skipped with `WITH_PIPER=0`. |
| `requirements.txt` | Deliberately short: FastAPI/uvicorn, httpx, prometheus-client, numpy, soxr. Lower bounds rather than pins — the stack builds this image locally, and a stale hard pin fails a build for no benefit. |
