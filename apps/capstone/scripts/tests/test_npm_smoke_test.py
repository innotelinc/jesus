#!/usr/bin/env python3
"""Regression tests for scripts/npm-smoke-test.py's UI image probe.

``probe_ui_image`` is the only check in the smoke test that can name a stale UI
image, and it is the reason the check reads a BODY rather than a status. The
sign-in walk passes on an image built from the registry's ``main``: the edge
sends every OIDC leg straight to the API, so the browser is handed to the IdP
either way. The probe instead asks ``/workflow`` with a cookie the API will
reject, and reads the page back:

  * an image carrying dograh/patches/0001 resolves that cookie as the session
    and renders the page, and
  * a registry build has a ``getServerAccessToken()`` that knows only
    ``stack``/``local``, so the same cookie resolves to no token and the page
    renders the ``Authentication required`` dead end.

Both answer HTTP 200 with a page on it, so a status-only assertion passes on
both — which is what these tests pin: the pass branch, the dead-end branch with
its patch attribution, the branch that reports a cookie the image did not
honour, and an unreachable host. The module is loaded by path (its filename is
not importable) so the real function runs; only urllib's opener is replaced, so
nothing leaves the process and the suite stays stdlib-only and offline.
"""

import importlib.util
import io
import os
import unittest
import urllib.error
from contextlib import contextmanager
from urllib.parse import urlparse

_SCRIPT = os.path.abspath(
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "npm-smoke-test.py")
)
_spec = importlib.util.spec_from_file_location("npm_smoke_test", _SCRIPT)
smoke = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(smoke)

PROBE_HOST = "voice.capstone.innotel.us"


class _Response:
    """The slice of http.client.HTTPResponse ``probe_ui_image`` uses."""

    def __init__(self, status, body):
        self.status = status
        self._body = body
        self.read_sizes = []

    def read(self, size=-1):
        self.read_sizes.append(size)
        return self._body if size is None or size < 0 else self._body[:size]

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


class _Opener:
    """Stands in for the module's NoRedirect opener and records what it was asked.

    ``error`` is raised instead of returning a response, so the same stub covers
    the HTTPError and the connect-failure branches.
    """

    def __init__(self, *, status=200, body=b"", error=None):
        self.status = status
        self.body = body
        self.error = error
        self.requests = []
        self.responses = []

    def open(self, request, timeout=None):
        self.requests.append(request)
        if self.error is not None:
            raise self.error
        response = _Response(self.status, self.body)
        self.responses.append(response)
        return response


@contextmanager
def _patched(name, value):
    saved = getattr(smoke, name)
    setattr(smoke, name, value)
    try:
        yield value
    finally:
        setattr(smoke, name, saved)


def _http_error(code, body):
    return urllib.error.HTTPError(
        f"https://{PROBE_HOST}{smoke.UI_PAGE}", code, "error", {}, io.BytesIO(body)
    )


class ProbeUiImageTests(unittest.TestCase):
    def probe(self, opener):
        with _patched("OPENER", opener):
            return smoke.probe_ui_image(PROBE_HOST, timeout=1)

    def test_the_probe_is_the_workflow_page_with_the_probe_cookie(self):
        opener = _Opener(body=b"<html>anything</html>")
        self.probe(opener)
        request = opener.requests[0]
        self.assertEqual(request.full_url, f"https://{PROBE_HOST}{smoke.UI_PAGE}")
        self.assertEqual(urlparse(request.full_url).path, "/workflow")
        self.assertEqual(request.get_header("Cookie"), "dograh_auth_token=probe")

    def test_a_patched_page_passes(self):
        ok, note = self.probe(_Opener(body=b"<html><h1>Your Agents</h1></html>"))
        self.assertTrue(ok, note)
        self.assertIn("patched UI", note)

    def test_the_dead_end_fails_and_names_the_missing_patch(self):
        ok, note = self.probe(
            _Opener(body=b'<div class="text-red-500">Authentication required. '
                         b"Please refresh the page.</div>")
        )
        self.assertFalse(ok)
        self.assertIn("predates", note)
        self.assertIn("0001", note)

    def test_the_dead_end_is_reported_even_on_an_error_status(self):
        # The body test runs before the status test on purpose: the page the
        # probe reads must be named as the pre-0001 dead end whenever it is
        # there, whatever status carried it.
        ok, note = self.probe(
            _Opener(error=_http_error(500, b"Authentication required. Please refresh the page."))
        )
        self.assertFalse(ok)
        self.assertIn("0001", note)
        self.assertNotIn("probe cookie", note)

    def test_a_non_200_without_the_dead_end_reports_the_cookie_was_not_honoured(self):
        ok, note = self.probe(_Opener(status=500, body=b"<html>boom</html>"))
        self.assertFalse(ok)
        self.assertIn("500", note)
        self.assertIn("probe cookie", note)

    def test_an_error_response_is_read_before_it_is_judged(self):
        ok, note = self.probe(_Opener(error=_http_error(307, b"<html>moved</html>")))
        self.assertFalse(ok)
        self.assertIn("307", note)

    def test_an_unreachable_host_fails_with_the_connect_reason(self):
        ok, note = self.probe(_Opener(error=urllib.error.URLError("no route to host")))
        self.assertFalse(ok)
        self.assertIn("connect", note)
        self.assertIn("no route to host", note)

    def test_the_probe_never_reads_a_body_larger_than_its_cap(self):
        opener = _Opener(body=b"x" * (smoke.UI_PROBE_BODY_LIMIT + 4096))
        self.probe(opener)
        self.assertEqual(opener.responses[0].read_sizes, [smoke.UI_PROBE_BODY_LIMIT])
        self.assertEqual(smoke.UI_PROBE_BODY_LIMIT, 512 * 1024)

    def test_the_marker_constants_match_what_the_probe_looks_for(self):
        self.assertEqual(smoke.UI_DEAD_END, "Authentication required")
        self.assertEqual(smoke.UI_PAGE, "/workflow")


class EdgeReachableTests(unittest.TestCase):
    """The preflight that turns \"no route to the estate\" into a SKIP (exit 2).

    A scheduled run on a hosted runner cannot reach the edge, and must not be
    reported as fifteen broken hosts.
    """

    def test_any_answer_from_the_edge_counts_as_reachable(self):
        calls = []

        def fake_fetch(url, timeout):
            calls.append((url, timeout))
            return 500, None  # an HTTP answer is still an answer

        with _patched("fetch", fake_fetch):
            self.assertTrue(smoke.edge_reachable("capstone.innotel.us", 5))
        self.assertEqual(calls, [("https://capstone.innotel.us/", 5)])

    def test_a_connect_failure_is_not_reachable(self):
        def fake_fetch(url, timeout):
            raise urllib.error.URLError("Name or service not known")

        with _patched("fetch", fake_fetch):
            self.assertFalse(smoke.edge_reachable("capstone.innotel.us", 5))


class WalkToAuthorizeTests(unittest.TestCase):
    """The sign-in walk's per-request budget.

    The canonical host answers the entry by building the authorize URL from its
    own OIDC discovery document, whose fetch carries a 15s timeout of its own.
    A request budget below that reports a working entry as a timeout on a cold
    start — the intermittent "capstone.innotel.us/api/v1/auth/oidc/login FAIL
    (The read operation timed out)" on the schedule. The walk floors the budget
    so a slow discovery fetch is not mistaken for a broken entry.
    """

    def test_the_budget_is_floored_above_the_api_discovery_timeout(self):
        seen = []

        def fake_fetch(url, timeout):
            seen.append(timeout)
            return 307, "https://auth.cerulean.innotel.us/application/o/authorize/?client_id=dograh"

        with _patched("fetch", fake_fetch):
            ok, _ = smoke.walk_to_authorize(
                "https://capstone.innotel.us/api/v1/auth/oidc/login", 12
            )
        self.assertTrue(ok)
        self.assertGreaterEqual(seen[0], smoke.PROBE_TIMEOUT_FLOOR)
        # The floor has to clear the API's own 15s discovery fetch, or the entry
        # can still time out on a cold start.
        self.assertGreater(smoke.PROBE_TIMEOUT_FLOOR, 15)

    def test_a_budget_above_the_floor_is_left_alone(self):
        seen = []

        def fake_fetch(url, timeout):
            seen.append(timeout)
            return 307, "https://auth.cerulean.innotel.us/application/o/authorize/?client_id=dograh"

        with _patched("fetch", fake_fetch):
            smoke.walk_to_authorize(
                "https://capstone.innotel.us/api/v1/auth/oidc/login", 40
            )
        self.assertEqual(seen[0], 40)


if __name__ == "__main__":
    unittest.main()
