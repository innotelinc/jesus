#!/usr/bin/env python3
"""Send an SMS from the Capstone AI agent stack.

Thin wrapper over zeus_client.py. Reads config from the stack .env (or
OS-level env), validates the recipient, and hands off to Zeus's SMS portal
endpoint. Designed to be called both by the dograh tool layer and directly
from the CLI.

Usage:
    python3 scripts/send_sms.py "+12223334444" "Your appointment is at 3pm."
    python3 scripts/send_sms.py --json +12223334444 "…"            # machine-readable
    python3 scripts/send_sms.py --list                                    # enumerate from zeus_client

Exit codes mirror zeus_client's messaging helpers: 0 on success, 1 on client
error (bad args / network / auth), 2 on validation error (bad number).
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from pathlib import Path
from typing import Any

# ---------------------------------------------------------------------------
# Locate zeus_client.py one directory up from this script (same layout as the
# repo tests assume). Import it as a module so we can reuse its config + HTTP
# helpers rather than re-implementing the API surface.
# ---------------------------------------------------------------------------
_SCRIPT_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(_SCRIPT_DIR.parent))
import zeus_client as zc  # noqa: E402


# ---------------------------------------------------------------------------
# Validation & formatting helpers
# ---------------------------------------------------------------------------

# E.164-ish acceptance window. We're permissive on entry but always normalise
# to a leading "+" and digits-only before handing the number to Zeus.
_PHONE_RE = re.compile(r"^\+?[1-9]\d{6,14}$")

# Basic plausibility filter: US/CA "1" prefix is fine, rest of the world
# numbers with 7-15 digits after the country code are accepted by the regex
# above. We do *not* try to be a full ITU validator here — Zeus will reject
# unreachable numbers with its own error shape.
def normalise_number(raw: str) -> str:
    """Strip everything except digits and a leading '+', then validate."""
    s = raw.strip()
    if s.startswith("+"):
        digits = "+" + re.sub(r"[^\d]", "", s[1:])
    else:
        digits = "+" + re.sub(r"[^\d]", "", s)
    if not _PHONE_RE.match(digits):
        raise ValueError(f"Unrecognisable phone number: {raw!r} -> {digits!r}")
    return digits


# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

def _cpbx_env() -> dict[str, str]:
    """Best-effort read of Capstone's .env (same shape as .env.example)."""
    env_file = _SCRIPT_DIR.parent / ".env"
    out: dict[str, str] = {}
    if env_file.is_file():
        for line in env_file.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, val = line.partition("=")
            out[key.strip()] = val.strip().strip('"').strip("'")
    return out


def _zeus_base_url() -> str:
    """Portal base URL for Zeus's SMS/fax/voicemail APIs.

    Precedence:
      1. CAPSTONE_PBX env (standalone mode points at a bundled PBX).
      2. ZEUS_PORTAL_URL env (explicit override).
      3. .env CAPSTONE_ZEUS_URL (portable-stack convention).
      4. compose default http://zeus-portal:3000 (container network).
      5. LAN fallback http://192.168.1.46:3001 (same host, outside compose).
    """
    for name in ("CAPSTONE_PBX", "ZEUS_PORTAL_URL", "CAPSTONE_ZEUS_URL"):
        val = os.environ.get(name) or _cpbx_env().get(name)
        if val:
            return val.rstrip("/")
    # Default to the compose service name when running inside the stack's
    # network; rely on the caller to set CAPSTONE_PBX/ZEUS_PORTAL_URL when
    # running outside compose (CI, local dev on the LAN).
    return "http://zeus-portal:3000"


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def send_sms(
    to: str,
    text: str,
    *,
    from_number: str | None = None,
    json_out: bool = False,
) -> dict[str, Any] | None:
    """Send *text* to *to* through Zeus's SMS portal.

    Returns a machine-readable dict on success when *json_out* is True,
    otherwise None. Raises on failure so callers can decide how to present
    the error (CLI, tool layer, webhook, etc.).
    """
    to = normalise_number(to)
    if not text:
        raise ValueError("SMS body must not be empty")

    base = _zeus_base_url()
    # zeus_client's send_sms(to_number, from_did_id, body) — note the
    # from_did_id is the DID identifier, not a raw phone number. We map our
    # from_number through the listed DIDs when possible so the caller gets a
    # stable API instead of needing to know DID internals.
    try:
        client = zc.ZeusClient(base=base)
    except Exception as exc:
        msg = f"Cannot reach Zeus SMS portal at {base}: {exc}"
        return _maybe_json({"error": msg, "to": to}, json_out, 1)

    from_did_id: str | None = None
    if from_number:
        numbers = list_numbers()
        match = [n for n in numbers if n.get("number") == from_number]
        if match:
            from_did_id = str(match[0].get("did_id") or match[0].get("id"))
        else:
            # Honour an explicit fromNumber even if we can't resolve it to a
            # DID id — zeus_client will surface its own validation error.
            from_did_id = from_number

    try:
        resp = client.send_sms(to_number=to, from_did_id=from_did_id, body=text)
    except TypeError:
        # Older zeus_client signatures may not accept the kwargs we pass.
        resp = client.send_sms(to, from_did_id or "", text)

    # zeus_client.send_sms returns the parsed JSON body on success; on failure
    # it raises. We translate both into the shape this script's callers expect.
    if isinstance(resp, dict) and resp.get("ok") is False:
        return _maybe_json(
            {"error": resp.get("error") or "Zeus rejected the SMS", "to": to},
            json_out,
            1,
        )

    return _maybe_json(
        {
            "ok": True,
            "to": to,
            "message_id": resp.get("message_id") if isinstance(resp, dict) else None,
            "status": resp.get("status") if isinstance(resp, dict) else "queued",
        },
        json_out,
        0,
    )


def list_numbers() -> list[dict[str, Any]]:
    """Enumerate SMS-capable numbers known to the configured Zeus portal.

    Mostly useful for the CLI ``--list`` path and for dograh tool introspection.
    Returns a list of dicts with at least ``number`` and ``did_id`` keys.
    """
    base = _zeus_base_url()
    try:
        client = zc.ZeusClient(base=base)
        numbers = getattr(client, "list_sms_numbers", lambda: [])()
        if isinstance(numbers, list):
            return _normalise_number_list(numbers)
    except Exception:
        pass
    # Fallback direct read if zeus_client doesn't expose the helper yet.
    try:
        import requests as _requests

        resp = _requests.get(f"{base}/api/sms/numbers", timeout=15)
        resp.raise_for_status()
        return _normalise_number_list(resp.json())
    except Exception as exc:
        print(f"Error listing numbers: {exc}", file=sys.stderr)
        return []


def _normalise_number_list(numbers: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Make Zeus's number-shape uniform across API versions.

    Gracefully skips entries whose phone field doesn't look like a usable
    E.164-ish number instead of crashing the whole listing.
    """
    out: list[dict[str, Any]] = []
    for n in numbers:
        if not isinstance(n, dict):
            continue
        number = str(n.get("number") or n.get("phone") or n.get("phone_number") or "").strip()
        if not number:
            continue
        try:
            normed = normalise_number(number)
        except ValueError:
            continue
        out.append({
            "number": normed,
            "did_id": str(n.get("did_id") or n.get("id") or n.get("did") or ""),
            "label": n.get("label") or n.get("name") or n.get("status") or "",
            "status": n.get("status") or "",
        })
    return out


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def _maybe_json(payload: dict[str, Any], json_out: bool, exit_code: int) -> dict[str, Any] | None:
    if json_out:
        print(json.dumps(payload, ensure_ascii=False, indent=2))
    else:
        status = "OK" if payload.get("ok") else "ERROR"
        print(f"[{status}] {payload.get('to', 'unknown')} — {payload.get('status') or payload.get('error') or ''}")
    sys.exit(exit_code)
    return payload  # never reached, but keeps type-checkers happy


def main(argv: list[str] | None = None) -> None:
    ap = argparse.ArgumentParser(
        prog="send_sms",
        description="Send an SMS via the configured Zeus SMS portal.",
    )
    ap.add_argument("to", nargs="?", help="Recipient phone number (E.164-ish).")
    ap.add_argument("text", nargs="?", help="SMS body text.")
    ap.add_argument("--json", action="store_true", help="Emit machine-readable JSON to stdout.")
    ap.add_argument("--from", dest="from_number", help="Optional sender/number to originate from.")
    ap.add_argument(
        "--list",
        action="store_true",
        help="List SMS-capable numbers from Zeus instead of sending.",
    )
    args = ap.parse_args(argv)

    if args.list:
        numbers = list_numbers()
        if args.json:
            print(json.dumps(numbers, ensure_ascii=False, indent=2))
        else:
            if not numbers:
                print("No SMS-capable numbers found.")
            else:
                for n in numbers:
                    print(f"{n.get('number')} — {n.get('label') or n.get('status') or ''}")
        return

    if not args.to or not args.text:
        ap.error("usage: send_sms.py <to> <text> [--json] [--from <sender>]")

    try:
        send_sms(args.to, args.text, from_number=args.from_number, json_out=args.json)
    except ValueError as exc:
        payload = {"error": str(exc), "to": args.to}
        _maybe_json(payload, args.json, 2)
    except SystemExit:
        raise
    except Exception as exc:
        payload = {"error": f"Unexpected error: {exc}"}
        _maybe_json(payload, args.json, 1)


if __name__ == "__main__":
    main()
