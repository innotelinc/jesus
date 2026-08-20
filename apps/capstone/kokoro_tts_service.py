"""
Kokoro HTTP TTS for the dograh pipeline (capstone).

⚠️ IMPORTANT CORRECTION — Pipecat's BUILT-IN `KokoroTTSService`
(`pipecat.services.kokoro.tts`) runs the kokoro-onnx model IN-PROCESS: it takes
ONNX model file paths, downloads model files on first use, and never talks to
an HTTP server. It CANNOT be pointed at the local `kokoro-fastapi` container.

The container exposes an OpenAI-compatible `POST /v1/audio/speech`, so the
right Pipecat class is `OpenAITTSService` with a custom `base_url`. The one
blocker: `OpenAITTSService.run_tts` validates `voice` against a hardcoded list
of OpenAI voices (alloy, ash, ballad, ...) and rejects Kokoro voices like
`af_heart` before the request is even sent. The subclass below removes that
gate and passes the voice name straight through.

VERIFIED: this exact approach is what dograh's service_factory uses to route
the OpenAI provider branch to kokoro-fastapi (see the wiring section below).

INSTALL
───────
Copy to:  api/services/pipecat/kokoro_tts.py   (next to minimax_tts.py in the
dograh / vai-platform clone).

================================================================================
THE SNIPPET — import → instantiate → pass into the pipeline
================================================================================

1) IMPORT (in your dograh service factory / pipeline builder):

    from api.services.pipecat.kokoro_tts import KokoroHttpTTSService

2) INSTANTIATE — point `base_url` at the local container. dograh runs in
   HOST mode, so the container's published port is on loopback. The voice is
   any Kokoro voice (af_heart, am_michael, af_bella, ...); the API key is
   ignored by kokoro-fastapi, so any non-empty string works.

    tts = KokoroHttpTTSService(
        api_key="local",
        base_url="http://127.0.0.1:8880/v1",   # kokoro-fastapi container URL
        sample_rate=24000,
        settings=OpenAITTSSettings(model="kokoro", voice="af_heart"),
        text_filters=[xml_function_tag_filter],
        skip_aggregator_types=["recording_router", "recording"],
        silence_time_s=1.0,
    )

3) PASS into the Pipecat pipeline (dograh's Pipeline):

    pipeline = Pipeline(
        [
            stt,                              # local Speaches STT
            context_aggregator.user(),
            llm,                              # local LLM via 9Router/OmniRoute
            tts,                              # ← KokoroHttpTTSService (above)
            context_aggregator.assistant(),
        ]
    )

   In dograh specifically, the factory wiring below replaces the OPENAI branch
   of `create_tts_service(...)` so the UI-config'd TTS (provider=OpenAI,
   base_url=http://127.0.0.1:8880/v1, voice=af_heart) produces this service —
   no pipeline code change required.

   (Modern alternative — ZERO code: dograh's `speaches` TTS provider already
   passes provider-specific voices verbatim and requests pcm, so you can just
   set provider=speaches, base_url=http://127.0.0.1:8880/v1 in the dograh UI
   and skip this file entirely. The subclass below is for the OpenAI branch.)
================================================================================
"""

from pipecat.services.openai.tts import OpenAITTSService


class KokoroHttpTTSService(OpenAITTSService):
    """OpenAI-compatible TTS pointed at a local kokoro-fastapi server.

    Same as OpenAITTSService but skips the hardcoded OpenAI-only voice allowlist
    so Kokoro voice names (``af_heart``, ``am_michael``, ...) are sent verbatim.
    """

    async def run_tts(self, text: str, context_id: str):
        # Import frames lazily to keep the module import-light.
        from pipecat.frames.frames import ErrorFrame, TTSAudioRawFrame

        voice = self._settings.voice
        if not voice:
            yield ErrorFrame(error="Kokoro TTS voice must be specified")
            return

        try:
            # Same request shape as the parent, but the voice name is passed
            # through unchanged and "pcm" is requested (kokoro-fastapi supports
            # pcm, wav, mp3, flac, ...).
            create_params = {
                "input": text,
                "model": self._settings.model,
                "voice": voice,
                "response_format": "pcm",
            }
            if self._settings.speed:
                create_params["speed"] = self._settings.speed

            async with self._client.audio.speech.with_streaming_response.create(
                **create_params
            ) as r:
                if r.status_code != 200:
                    error = await r.text()
                    yield ErrorFrame(
                        error=f"Kokoro TTS error (status: {r.status_code}, error: {error})"
                    )
                    return

                await self.start_tts_usage_metrics(text)

                async for chunk in r.iter_bytes(self.chunk_size):
                    if len(chunk) > 0:
                        await self.stop_ttfb_metrics()
                        yield TTSAudioRawFrame(
                            chunk, self.sample_rate, 1, context_id=context_id
                        )
        except Exception as e:
            yield ErrorFrame(error=f"Unknown Kokoro TTS error: {e}")
        finally:
            await self.stop_ttfb_metrics()


# ── dograh factory wiring (api/services/pipecat/service_factory.py) ─────────
#
#  1. Add the import (alphabetize next to the other pipecat imports):
#         from api.services.pipecat.kokoro_tts import KokoroHttpTTSService
#
#  2. In `create_tts_service`, change the OPENAI branch to use the subclass:
#
#         elif user_config.tts.provider == ServiceProviders.OPENAI.value:
#             kwargs = {}
#             base_url = getattr(user_config.tts, "base_url", None)
#             if base_url:
#                 _validate_runtime_service_url(base_url, "base_url")
#                 kwargs["base_url"] = base_url
#             return KokoroHttpTTSService(          # was: OpenAITTSService
#                 api_key=user_config.tts.api_key,
#                 sample_rate=OPENAI_SAMPLE_RATE,
#                 settings=OpenAITTSSettings(model=user_config.tts.model),
#                 text_filters=[xml_function_tag_filter],
#                 skip_aggregator_types=["recording_router", "recording"],
#                 silence_time_s=1.0,
#                 **kwargs,
#             )
#
# DOGRAH UI CONFIG (TTS section)
# ─────────────────────────────
#   provider   : OpenAI
#   model      : kokoro            (any string; kokoro-fastapi ignores it)
#   voice      : af_heart          (any Kokoro voice: af_heart, am_michael, ...)
#   base_url   : http://127.0.0.1:8880/v1   (dograh runs in host mode)
#   api_key    : anything          (kokoro-fastapi doesn't check it)
