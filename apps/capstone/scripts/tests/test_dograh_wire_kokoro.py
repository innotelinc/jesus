#!/usr/bin/env python3
"""Tests for scripts/dograh_wire.py — the TTS (voice) reconcile step.

The agents' voice comes from the organization's model configuration, not from
the workflow JSONs, so "use Kokoro" is a write against dograh's API and not a
deploy. Two things about that write are worth pinning without a server:

* deciding whether it is needed at all — a re-run must be a no-op on a
  configuration that is already right, and must not confuse a *stored* value
  with an effective one; and
* what it sends — only the ``tts`` section may change, because the llm and stt
  halves carry masked secrets that dograh resolves on save, and rewriting them
  from this side is how a working pipeline loses its keys.

``kokoro_tts_problem``, ``with_kokoro_tts`` and ``shim_health_url`` are pure
functions over the API's own fields, which is what makes that testable.
"""

import importlib.util
import os
import unittest

_WIRE_PATH = os.path.abspath(
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "dograh_wire.py")
)
_spec = importlib.util.spec_from_file_location("dograh_wire", _WIRE_PATH)
dograh_wire = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(dograh_wire)

BASE_URL = dograh_wire.DEFAULT_TTS_BASE_URL
MODEL = dograh_wire.DEFAULT_TTS_MODEL
VOICE = dograh_wire.DEFAULT_TTS_VOICE


def configured(tts):
    """A stored v2 configuration whose only interesting part is `tts`."""
    return {
        "version": 2,
        "mode": "byok",
        "byok": {
            "mode": "pipeline",
            "pipeline": {
                "llm": {"provider": "openai", "model": "auto", "api_key": "sk-…abcd"},
                "stt": {
                    "provider": "speaches",
                    "model": "Systran/faster-distil-whisper-small.en",
                    "base_url": "http://127.0.0.1:8001/v1",
                },
                "tts": tts,
            },
        },
    }


KOKORO = {
    "provider": "speaches",
    "api_key": "none",
    "base_url": BASE_URL,
    "model": MODEL,
    "voice": VOICE,
}


class KokoroTtsProblemTest(unittest.TestCase):
    def test_a_kokoro_configuration_needs_nothing(self):
        self.assertEqual(
            dograh_wire.kokoro_tts_problem(configured(KOKORO), BASE_URL, MODEL, VOICE), ""
        )

    def test_a_trailing_slash_is_not_a_difference(self):
        # Rewriting the same endpoint over a slash would make every run write.
        tts = {**KOKORO, "base_url": BASE_URL + "/"}
        self.assertEqual(
            dograh_wire.kokoro_tts_problem(configured(tts), BASE_URL, MODEL, VOICE), ""
        )

    def test_a_cloud_provider_is_reported(self):
        tts = {"provider": "openai", "model": "tts-1", "voice": "alloy"}
        problem = dograh_wire.kokoro_tts_problem(configured(tts), BASE_URL, MODEL, VOICE)
        self.assertIn("'openai'", problem)
        self.assertIn("speaches", problem)

    def test_a_wrong_endpoint_model_or_voice_is_reported(self):
        for tts, expected in (
            ({**KOKORO, "base_url": "http://127.0.0.1:8880/v1"}, "base_url"),
            ({**KOKORO, "model": "tts-1"}, "model"),
            ({**KOKORO, "voice": "am_michael"}, "voice"),
        ):
            problem = dograh_wire.kokoro_tts_problem(configured(tts), BASE_URL, MODEL, VOICE)
            self.assertIn(expected, problem)

    def test_no_tts_at_all_is_reported_as_silence(self):
        # What an unwired organization does on a call: nothing to speak with.
        problem = dograh_wire.kokoro_tts_problem(configured({}), BASE_URL, MODEL, VOICE)
        self.assertIn("no TTS engine", problem)
        self.assertIn("never responds", problem)
        self.assertTrue(dograh_wire.kokoro_tts_problem(None, BASE_URL, MODEL, VOICE))


class WithKokoroTtsTest(unittest.TestCase):
    def test_the_other_halves_are_carried_over_untouched(self):
        # The masked llm key has to survive verbatim: dograh resolves it against
        # the stored secret, and a value it does not recognise fails the save.
        before = configured({"provider": "openai", "model": "tts-1", "voice": "alloy"})
        after = dograh_wire.with_kokoro_tts(before, BASE_URL, MODEL, VOICE)
        pipeline = after["byok"]["pipeline"]
        self.assertEqual(pipeline["llm"], before["byok"]["pipeline"]["llm"])
        self.assertEqual(pipeline["stt"], before["byok"]["pipeline"]["stt"])
        self.assertEqual(after["version"], 2)
        self.assertEqual(after["mode"], "byok")
        self.assertEqual(after["byok"]["mode"], "pipeline")

    def test_only_the_tts_section_is_replaced(self):
        after = dograh_wire.with_kokoro_tts(configured({}), BASE_URL, MODEL, VOICE)
        self.assertEqual(
            after["byok"]["pipeline"]["tts"],
            {
                "provider": "speaches",
                "api_key": "none",
                "base_url": BASE_URL,
                "model": MODEL,
                "voice": VOICE,
            },
        )

    def test_a_configured_speed_is_kept(self):
        before = configured({**KOKORO, "speed": 0.8})
        after = dograh_wire.with_kokoro_tts(before, BASE_URL, MODEL, VOICE)
        self.assertEqual(after["byok"]["pipeline"]["tts"]["speed"], 0.8)

    def test_the_input_is_not_mutated(self):
        before = configured({"provider": "openai"})
        dograh_wire.with_kokoro_tts(before, BASE_URL, MODEL, VOICE)
        self.assertEqual(before["byok"]["pipeline"]["tts"], {"provider": "openai"})

    def test_the_result_agrees_with_the_checker(self):
        # The write and the decision have to share one idea of "correct", or the
        # script writes on every run.
        after = dograh_wire.with_kokoro_tts(configured({"provider": "openai"}), BASE_URL, MODEL, VOICE)
        self.assertEqual(dograh_wire.kokoro_tts_problem(after, BASE_URL, MODEL, VOICE), "")


class ShimHealthUrlTest(unittest.TestCase):
    def test_the_health_probe_drops_the_openai_path(self):
        self.assertEqual(
            dograh_wire.shim_health_url("http://127.0.0.1:8881/v1"),
            "http://127.0.0.1:8881/health",
        )
        self.assertEqual(
            dograh_wire.shim_health_url("http://127.0.0.1:8881/v1/"),
            "http://127.0.0.1:8881/health",
        )

    def test_a_base_without_the_path_still_probes_something(self):
        self.assertEqual(
            dograh_wire.shim_health_url("http://tts-shim:8880"), "http://tts-shim:8880/health"
        )


if __name__ == "__main__":
    unittest.main()
