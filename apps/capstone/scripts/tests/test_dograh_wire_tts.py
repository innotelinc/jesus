#!/usr/bin/env python3
"""Tests for scripts/dograh_wire.py — the TTS (voice) reconcile step.

The agents' voice comes from the organization's model configuration, not from
the workflow JSONs, so "use Piper" is a write against dograh's API and not a
deploy. Since model-configuration v3 a role names a provider *connection*
(rather than carrying its own ``base_url``), which is why the decision needs
both the stored configuration and the connection the address lives on. Three
things about that write are worth pinning without a server:

* deciding whether it is needed at all — a re-run must be a no-op on a
  configuration that is already right;
* which connection counts as "the local shim" — the gap and the 24 kHz STT
  connection are the same provider, so the address is what tells them apart; and
* what it sends — only the ``tts`` role may change, because every other role
  names its own connection and rewriting one from this side is how a working
  pipeline loses its LLM.

``shim_connection``, ``shim_tts_problem``, ``with_shim_tts`` and
``shim_health_url`` are pure functions over the API's own fields, which is what
makes that testable.
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

SHIM_UUID = "a2448c89-4bb1-4306-8abe-9347eb9be0bd"

CONNECTION = {
    "uuid": SHIM_UUID,
    "provider": "speaches",
    "connection_settings": {"base_url": BASE_URL},
}

# The 24 kHz STT connection: same provider, a different address. If a test ever
# lets this one count as "the shim", the reconcile would point TTS at STT.
STT_CONNECTION = {
    "uuid": "ca89e25f-7486-431c-a8c8-23b7d47eb232",
    "provider": "speaches",
    "connection_settings": {"base_url": "http://127.0.0.1:8001/v1"},
}

CORRECT_TTS = {
    "settings": {"model": MODEL, "voice": VOICE, "speed": 1.0},
    "provider_connection_uuid": SHIM_UUID,
}


def configured(tts):
    """A stored v3 configuration whose only interesting part is `tts`."""
    return {
        "version": 3,
        "mode": "pipeline",
        "llm": {
            "settings": {"model": "auto/best-fast"},
            "provider_connection_uuid": "llm-uuid",
        },
        "llm_fallback": None,
        "stt": {
            "settings": {"model": "Systran/faster-distil-whisper-small.en"},
            "provider_connection_uuid": STT_CONNECTION["uuid"],
        },
        "tts": tts,
        "realtime": None,
        "embeddings": {
            "settings": {"model": "openrouter/openai/text-embedding-3-small"},
            "provider_connection_uuid": "llm-uuid",
        },
    }


class ShimConnectionTest(unittest.TestCase):
    def test_the_tts_connection_is_chosen_by_address(self):
        # Both connections are `speaches`; only the address tells them apart.
        found = dograh_wire.shim_connection([STT_CONNECTION, CONNECTION], BASE_URL)
        self.assertIs(found, CONNECTION)

    def test_a_trailing_slash_is_not_a_difference(self):
        connection = {
            **CONNECTION,
            "connection_settings": {"base_url": BASE_URL + "/"},
        }
        self.assertIs(dograh_wire.shim_connection([connection], BASE_URL), connection)

    def test_another_provider_is_not_the_shim(self):
        connection = {
            "uuid": "x",
            "provider": "openai",
            "connection_settings": {"base_url": BASE_URL},
        }
        self.assertIsNone(dograh_wire.shim_connection([connection], BASE_URL))

    def test_no_connection_at_all(self):
        self.assertIsNone(dograh_wire.shim_connection([], BASE_URL))
        self.assertIsNone(dograh_wire.shim_connection(None, BASE_URL))


class ShimTtsProblemTest(unittest.TestCase):
    def test_a_correct_configuration_needs_nothing(self):
        self.assertEqual(
            dograh_wire.shim_tts_problem(
                configured(CORRECT_TTS), CONNECTION, BASE_URL, MODEL, VOICE
            ),
            "",
        )

    def test_no_tts_at_all_is_reported_as_silence(self):
        problem = dograh_wire.shim_tts_problem(
            configured({}), CONNECTION, BASE_URL, MODEL, VOICE
        )
        self.assertIn("no TTS engine", problem)
        self.assertIn("never responds", problem)
        self.assertTrue(
            dograh_wire.shim_tts_problem(None, CONNECTION, BASE_URL, MODEL, VOICE)
        )

    def test_no_shim_connection_is_reported(self):
        problem = dograh_wire.shim_tts_problem(
            configured(CORRECT_TTS), None, BASE_URL, MODEL, VOICE
        )
        self.assertIn("no provider connection", problem)

    def test_tts_bound_to_another_connection_is_reported(self):
        tts = {**CORRECT_TTS, "provider_connection_uuid": STT_CONNECTION["uuid"]}
        problem = dograh_wire.shim_tts_problem(
            configured(tts), CONNECTION, BASE_URL, MODEL, VOICE
        )
        self.assertIn(STT_CONNECTION["uuid"], problem)
        self.assertIn(SHIM_UUID, problem)

    def test_a_wrong_model_or_voice_is_reported(self):
        for tts, expected in (
            ({**CORRECT_TTS, "settings": {"model": "kokoro", "voice": VOICE}}, "model"),
            ({**CORRECT_TTS, "settings": {"model": MODEL, "voice": "af_heart"}}, "voice"),
        ):
            problem = dograh_wire.shim_tts_problem(
                configured(tts), CONNECTION, BASE_URL, MODEL, VOICE
            )
            self.assertIn(expected, problem)

    def test_an_unset_voice_is_not_checked(self):
        tts = {**CORRECT_TTS, "settings": {"model": MODEL}}
        self.assertEqual(
            dograh_wire.shim_tts_problem(configured(tts), CONNECTION, BASE_URL, MODEL, ""),
            "",
        )


class WithShimTtsTest(unittest.TestCase):
    def test_the_other_roles_are_carried_over_untouched(self):
        # Every other role names its own connection; re-pointing TTS must not
        # disturb them, or a working pipeline loses its LLM.
        before = configured({"settings": {"model": "kokoro"}})
        after = dograh_wire.with_shim_tts(before, CONNECTION, MODEL, VOICE)
        self.assertEqual(after["llm"], before["llm"])
        self.assertEqual(after["stt"], before["stt"])
        self.assertEqual(after["embeddings"], before["embeddings"])
        self.assertEqual(after["mode"], before["mode"])
        self.assertEqual(after["version"], 3)

    def test_only_the_tts_role_is_replaced(self):
        after = dograh_wire.with_shim_tts(configured({}), CONNECTION, MODEL, VOICE)
        self.assertEqual(
            after["tts"],
            {
                "settings": {"model": MODEL, "voice": VOICE},
                "provider_connection_uuid": SHIM_UUID,
            },
        )

    def test_a_configured_speed_is_kept(self):
        before = configured({**CORRECT_TTS, "settings": {**CORRECT_TTS["settings"], "speed": 0.8}})
        after = dograh_wire.with_shim_tts(before, CONNECTION, MODEL, VOICE)
        self.assertEqual(after["tts"]["settings"]["speed"], 0.8)

    def test_the_input_is_not_mutated(self):
        before = configured({"settings": {"model": "kokoro"}})
        dograh_wire.with_shim_tts(before, CONNECTION, MODEL, VOICE)
        self.assertEqual(before["tts"], {"settings": {"model": "kokoro"}})

    def test_the_result_agrees_with_the_checker(self):
        # The write and the decision have to share one idea of "correct", or the
        # script writes on every run.
        before = configured({"settings": {"model": "kokoro"}})
        after = dograh_wire.with_shim_tts(before, CONNECTION, MODEL, VOICE)
        self.assertEqual(
            dograh_wire.shim_tts_problem(after, CONNECTION, BASE_URL, MODEL, VOICE), ""
        )


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
