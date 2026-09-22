#!/usr/bin/env python3
"""sso-smoke.py — prove a NEW identity can sign in, and that an address clash
does not stop one.

WHY THIS EXISTS NEXT TO verify-dograh-sso.py. That script signs in an EXISTING
admin and asserts which organization they land in. This one covers the other
half — provisioning — because that is where the failures live that no amount of
reading the config will find:

  * the callback inserts a local row keyed on the provider subject, so the
    FIRST sign-in of any identity is the only one that exercises the insert;
  * the provider subject is derived (`sha256("{user_id}-{install_id}")`), so a
    rebuilt Authentik — or one account deleted and recreated at the provider —
    changes it, and the callback then has to reconcile an address that another
    row already holds. That used to abort with a UniqueViolationError, which
    the callback renders as the same generic "Sign-in could not be completed"
    as every other failure in the chain (see dograh/patches/0004).

Both passes end at the same assertion a browser would reach: an access token
from the callback, accepted by an authenticated API endpoint.

The Authentik client and the flow choreography are verify-sso.py's — the
convention verify-dograh-sso.py sets — so what is left here is only what is
dograh-specific: the app's own /api/v1/auth/oidc/login entry (it answers 307 +
a state cookie rather than redirecting from `/`), and the callback's
`#access_token` fragment.

    AUTHENTIK_TOKEN=<api token> python3 scripts/ci/sso-smoke.py

Exit codes, matching verify-sso.py: 0 = pass, 1 = a check failed, 2 = cannot
run (no token, no group, IdP unreachable) — which is a SKIP, not a failure.
"""
from __future__ import annotations

import argparse
import importlib.util
import json
import os
import pathlib
import subprocess
import sys
import time
import types
import urllib.error
import urllib.parse
import urllib.request

HERE = pathlib.Path(__file__).resolve().parent
# capstone/scripts/ci -> capstone/scripts
_spec = importlib.util.spec_from_file_location("verify_sso", HERE.parent / "verify-sso.py")
v = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(v)

APP = os.environ.get("DOGRAH_BASE", "https://dograh.capstone.innotel.us").rstrip("/")
LOGIN_PATH = "/api/v1/auth/oidc/login"
# Distinct per run so pass 1 provisions a genuinely new identity; pass 2 reuses
# it so the address is already taken by the row pass 1 created.
USERNAME = os.environ.get("SMOKE_USERNAME", f"sso-smoke-{int(time.time())}")
DB_CONTAINER = os.environ.get("SMOKE_DB_CONTAINER", "capstone-postgres-1")


def step(n, text):
    print(f"\n[{n}] {text}")


def app_client(cfg):
    return v.Client(cfg, base=APP)


def subject_of(api, username):
    """`oidc_<uid>` for a just-created identity, or "" if the provider hides it.

    Best effort: a provider that will not answer must not fail the run, it just
    means the cleanup falls back to the address.
    """
    try:
        found = api.call("GET", "/core/users/?username=" + urllib.parse.quote(username))
    except Exception:  # noqa: BLE001 - a cleanup aid, never a result
        return ""
    results = found.get("results") if isinstance(found, dict) else (found or [])
    if not results:
        return ""
    uid = results[0].get("uid")
    return f"oidc_{uid}" if uid else ""


def local_rows_created(subjects):
    """The local rows this run created, so the smoke test does not litter.

    Matching on the SUBJECT, not the address: the second pass deliberately
    collides on the address, and the callback then leaves its row with **no
    email at all** (that is the fix — refuse the address, keep the sign-in), so
    an address-based cleanup silently leaves exactly the row this test created.

    Best effort by design: in CI there is no Docker socket and nothing to clean
    up locally, which is fine — the run has still proved what it set out to.
    """
    if not _docker_available():
        print(f"[cleanup] no docker here — leaving the local rows for {USERNAME}")
        return
    by_subject = ", ".join("'" + s.replace("'", "''") + "'" for s in subjects) or "''"
    where = (f"provider_id IN ({by_subject}) "
             "OR email LIKE 'sso-smoke-%@innotel.us'")
    sql = (
        f"DELETE FROM organization_users WHERE user_id IN (SELECT id FROM users WHERE {where});"
        f"DELETE FROM users WHERE {where};"
    )
    try:
        subprocess.run(
            ["docker", "exec", DB_CONTAINER, "psql", "-U", "postgres", "-c", sql],
            check=True, capture_output=True, text=True,
        )
        print("[cleanup] removed the local rows for sso-smoke-%@innotel.us")
    except (OSError, subprocess.CalledProcessError) as err:
        print(f"[cleanup] WARNING: could not remove the local rows: {err}", file=sys.stderr)


def _docker_available():
    try:
        return subprocess.run(
            ["docker", "inspect", "-f", "{{.State.Running}}", DB_CONTAINER],
            capture_output=True, text=True,
        ).stdout.strip() == "true"
    except OSError:
        return False


def drive_login(cfg, client):
    """Walk dograh's sign-in as the browser does; return the final hop's Location.

    verify-sso.py's `sso_login` cannot be used here: it starts from `app + "/"`,
    which is right for the dashboard gateways but not for dograh, whose `/` is a
    Next.js page and whose IdP entry is the API route below. The stage loop is
    the same dance, so it stays recognisable next to that one.
    """
    step(3, "app login entry (this is what the browser hits)")
    status, authorize, _ = client.get(APP + LOGIN_PATH)
    state_cookie = client.cookie("dograh_oidc_state")
    print(f"    HTTP {status}")
    print(f"    location head: {(authorize or '-')[:72]}...")
    print(f"    state cookie: {'yes, %d chars' % len(state_cookie) if state_cookie else 'MISSING'}")
    v.require(status in (301, 302, 303, 307, 308) and state_cookie,
              f"the login entry must answer a redirect AND set the state cookie "
              f"(got HTTP {status}, cookie {'set' if state_cookie else 'missing'}) — "
              f"without both, the callback can only answer `expired`")
    v.require("client_id=" in (authorize or ""),
              "the authorize URL carries no client_id")

    # The authorize URL is absolute and names the IdP the app is actually
    # configured against. Pin the client to that origin: the hops that follow
    # are IdP-relative, and the client starts out based on the APP (which is a
    # different host), so resolving them against it asks dograh for Authentik's
    # flow executor and gets a 404.
    idp = urllib.parse.urlparse(authorize)
    client.base = f"{idp.scheme}://{idp.netloc}"

    step(4, "follow the authorization request (no session yet)")
    status, location, body = client.get(authorize)
    print(f"    HTTP {status} -> {(location or '-')[:80]}")
    v.require(status == 302 and location,
              f"authorize -> HTTP {status}: {body[:160]}")

    executor = (client.base + "/api/v3/flows/executor/" + v.AUTH_FLOW + "/?"
                + urllib.parse.urlencode({"query": urllib.parse.urlparse(location).query}))

    step(5, "authenticate against the flow executor")
    stage = client.follow_json(executor)
    for _ in range(8):
        component = stage.get("component")
        if component == "xak-flow-redirect":
            break
        if component == "ak-stage-identification":
            payload = {"uid_field": USERNAME}
        elif component == "ak-stage-password":
            payload = {"password": cfg.password}
        elif component == "ak-stage-consent":
            # A first-time identity can be shown consent; an empty POST is what
            # a browser does when the stage carries no required field.
            payload = {"consent": True}
        else:
            payload = {}
        print(f"    stage {component}")
        status, next_url, body = client.post(executor, payload)
        if status not in (200, 302):
            raise v.CheckFailed(f"{component} rejected (HTTP {status}): {body[:200]}")
        stage = client.follow_json(next_url or executor)
    v.require(stage.get("component") == "xak-flow-redirect",
              "Authentik's flow never handed back the authorize URL")

    step(6, "come back to the callback with the code")
    callback = client.follow_to_code(stage["to"])
    status, location, _ = client.get(callback)
    print(f"    HTTP {status} -> {(location or '-')[:96]}")
    v.require("error=" not in (location or ""),
              f"the callback refused the sign-in: {(location or '')[:160]}")
    return location or ""


def use_token(location):
    """Assert the callback's token actually works, the way the SPA uses it.

    The token arrives in the URL *fragment* (that is what the app's
    /auth/callback page reads), so a cookie-jar check alone would pass while the
    session was unusable.
    """
    step(7, "use the issued token")
    v.require("#" in location, "the callback redirect carried no fragment")
    token = dict(urllib.parse.parse_qsl(location.split("#", 1)[1])).get("access_token", "")
    print(f"    access_token: {'%d chars' % len(token) if token else 'MISSING'}")
    v.require(token, "the callback redirect carried no access_token")

    for path in ("/api/v1/auth/me", "/api/v1/user"):
        req = urllib.request.Request(APP + path)
        req.add_header("Authorization", "Bearer " + token)
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                body = resp.read().decode("utf-8", "replace")
                print(f"    GET {path} -> {resp.status}")
                try:
                    who = json.loads(body)
                except ValueError:
                    continue
                who = who if isinstance(who, dict) else {}
                print(f"        identity: {who.get('email') or who.get('username') or '(ok)'}")
                return
        except urllib.error.HTTPError as err:
            print(f"    GET {path} -> {err.code}")
    raise v.CheckFailed("the issued token was refused by every authenticated endpoint")


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--verbose", action="store_true", help="trace every HTTP hop")
    args = parser.parse_args()

    api = None
    created = False
    subjects = []
    try:
        # verify-sso.py's Config reads the token, the required group and the LAN
        # address the same way every other verifier does; only the app entry
        # below is specific to this script.
        cfg = v.Config(types.SimpleNamespace(
            base=None, host_ip=None, verbose=args.verbose,
        ))
        api = v.AuthApi(cfg)

        step(1, "resolve the allowed group")
        group = api.find_group(cfg.group)
        v.require(group, f"Authentik has no group named {cfg.group!r} — nothing could be admitted")
        print(f"    {cfg.group} = {group}")

        for attempt, where in ((1, "fresh identity (create + provision)"),
                               (2, "same address, NEW subject (the collision)")):
            step(2, f"pass {attempt}: {where}")
            # make_user deletes any user of this name first, so the second pass
            # gets the same address under a new pk — and because the subject is
            # derived from the pk, a new subject too. That is the provider
            # rebuild / account-recreation case, without rebuilding anything.
            pk = api.make_user(USERNAME, "SSO smoke (temporary)", groups=[group])
            created = True
            print(f"    {USERNAME}@innotel.us (pk={pk})")
            # The subject is derived from the user id, so it is only knowable by
            # asking the provider — and this is the run's only handle on the
            # addressless row the second pass leaves behind.
            subjects.append(subject_of(api, USERNAME))
            client = app_client(cfg)
            use_token(drive_login(cfg, client))
            print(f"    RESULT pass {attempt}: signed in")

        print("\nRESULT: a new identity can sign in, and an address already held by "
              "another subject does not stop one.")
        return 0
    except v.CheckFailed as err:
        print(f"\nFAIL: {err}", file=sys.stderr)
        return 1
    except v.CannotRun as err:
        print(f"\nSKIP: {err}", file=sys.stderr)
        return 2
    except Exception as err:  # noqa: BLE001 - a verifier must not traceback
        print(f"\nFAIL: unexpected {type(err).__name__}: {err}", file=sys.stderr)
        return 1
    finally:
        # Nothing to undo when the run never created anything — and a verifier
        # that skipped must not touch a live database on its way out.
        if created:
            try:
                api.delete_user(USERNAME)
                print(f"[cleanup] deleted {USERNAME} from the identity provider")
            except Exception as err:  # noqa: BLE001
                print(f"[cleanup] WARNING: could not delete {USERNAME}: {err}",
                      file=sys.stderr)
            try:
                local_rows_created([s for s in subjects if s])
            except Exception as err:  # noqa: BLE001 - cleanup never masks the result
                print(f"[cleanup] WARNING: local rows not removed: {err}", file=sys.stderr)


if __name__ == "__main__":
    sys.exit(main())
