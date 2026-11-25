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
from pathlib import Path

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


class StrayTtsKeysTest(unittest.TestCase):
    """A stray key beside `settings` takes every inbound call down.

    Observed 2026-11-25: `tts.connection_revision` was added while switching the
    voice, every value stayed correct, and dograh refused each run with
    "Quota exceeded for user 1" and a zero call duration. The check has to fire
    on the shape alone, before anything compares models.
    """

    def test_a_correct_configuration_has_no_stray_keys(self):
        self.assertEqual(dograh_wire.stray_tts_keys(configured(CORRECT_TTS)), [])
        self.assertEqual(dograh_wire.stray_tts_keys(None), [])
        self.assertEqual(dograh_wire.stray_tts_keys(configured({})), [])

    def test_connection_revision_is_named(self):
        tts = {**CORRECT_TTS, "connection_revision": 1}
        problem = dograh_wire.shim_tts_problem(
            configured(tts), CONNECTION, BASE_URL, MODEL, VOICE
        )
        self.assertIn("connection_revision", problem)
        self.assertIn("Quota exceeded", problem)

    def test_a_stray_setting_is_named_with_its_prefix(self):
        tts = {**CORRECT_TTS, "settings": {**CORRECT_TTS["settings"], "engine": "x"}}
        self.assertEqual(dograh_wire.stray_tts_keys(configured(tts)), ["settings.engine"])

    def test_a_stray_key_is_reported_before_a_matching_model_masks_it(self):
        # The dangerous case: model, voice and connection are all correct.
        tts = {**CORRECT_TTS, "connection_revision": 7}
        self.assertNotEqual(
            dograh_wire.shim_tts_problem(
                configured(tts), CONNECTION, BASE_URL, MODEL, VOICE
            ),
            "",
        )

    def test_rewriting_the_role_drops_the_stray_key(self):
        # self-heal: the write path builds `tts` from scratch, so a re-run of
        # the wire script repairs a configuration that already has the key.
        before = configured({**CORRECT_TTS, "connection_revision": 3})
        after = dograh_wire.with_shim_tts(before, CONNECTION, MODEL, VOICE)
        self.assertEqual(dograh_wire.stray_tts_keys(after), [])
        self.assertEqual(
            dograh_wire.shim_tts_problem(after, CONNECTION, BASE_URL, MODEL, VOICE), ""
        )


class GreetingPrewarmTest(unittest.TestCase):
    """The prewarm list only helps while it matches what a call will ask for.

    A greeting is rendered from ``{{initial_context.x | fallback:y}}``, so a
    route that supplies a name renders a different string than the fallbacks —
    and the text is part of the cache key, which makes a stale list a silent
    miss (1.76 s of dead air), not an error.
    """

    TEMPLATE = (
        "Hi {{initial_context.candidate_name | fallback:there}}, this is "
        "{{initial_context.interviewer_name | fallback:Jordan}} from "
        "{{initial_context.company | fallback:our company}}. I'm the interviewer "
        "for the {{initial_context.role | fallback:role}}."
    )

    def test_a_context_free_route_renders_the_fallbacks(self):
        self.assertEqual(
            dograh_wire.render_greeting(self.TEMPLATE, {}),
            "Hi there, this is Jordan from our company. I'm the interviewer for the role.",
        )

    def test_a_route_context_replaces_every_placeholder(self):
        rendered = dograh_wire.render_greeting(
            self.TEMPLATE,
            {"candidate_name": "Dana", "interviewer_name": "Sam", "company": "Acme"},
        )
        self.assertEqual(
            rendered, "Hi Dana, this is Sam from Acme. I'm the interviewer for the role."
        )

    def test_context_may_be_nested_or_flat(self):
        flat = dograh_wire.render_greeting(self.TEMPLATE, {"candidate_name": "Dana"})
        nested = dograh_wire.render_greeting(
            self.TEMPLATE, {"initial_context": {"candidate_name": "Dana"}}
        )
        self.assertEqual(flat, nested)
        self.assertIn("Hi Dana,", flat)

    def test_a_placeholder_without_a_fallback_becomes_empty(self):
        self.assertEqual(dograh_wire.render_greeting("Hi {{initial_context.n}}", {}), "Hi ")

    def test_drift_names_the_greeting_a_call_will_ask_for(self):
        wanted = dograh_wire.render_greeting(self.TEMPLATE, {"candidate_name": "Dana"})
        fallback = dograh_wire.render_greeting(self.TEMPLATE, {})
        self.assertEqual(dograh_wire.prewarm_drift(fallback, [wanted]), [wanted])

    def test_a_listed_greeting_is_not_drift(self):
        fallback = dograh_wire.render_greeting(self.TEMPLATE, {})
        self.assertEqual(dograh_wire.prewarm_drift(f"# note\n{fallback}\n", [fallback]), [])

    def test_comments_and_blank_lines_are_not_utterances(self):
        self.assertEqual(
            dograh_wire.prewarm_lines("# a comment\n\nHi there.\n"), ["Hi there."]
        )

    def test_the_shipped_workflows_render_their_fallbacks(self):
        repo = Path(dograh_wire.__file__).resolve().parent.parent
        rendered = dograh_wire.expected_greetings(repo / "dograh", [], {})
        self.assertEqual(len(rendered), 2, "the two live tracks each greet once")
        self.assertIn("this is Jordan from our company", rendered[0])
        self.assertIn("this is Robin from our organization", rendered[1])


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
