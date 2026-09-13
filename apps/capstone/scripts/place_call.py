#!/usr/bin/env python3
"""Place an interview call: originate → play a candidate loop on dograh-ext.

Usage:
    python3 scripts/place_call.py <extension> <sound> [timeout_s]

Examples:
    python3 scripts/place_call.py 8000 candidate-it
    python3 scripts/place_call.py 8001 candidate-devops
    python3 scripts/place_call.py 8002 candidate-sql

Extension → track routing (matches [dograh-inbound] dialplan):
    8000 = IT, 8001 = DevOps, 8002 = SQL

Mechanics: originate a Local channel into `dograh-inbound` with app=dograh
(Stasis). Once dograh attaches its WebSocket externalMedia channel
(`dograh-ext-*`) and it reaches state Up, we play the candidate loop on that
channel — this injects audio into the exact WS stream STT hears. (Playing on
the dialed leg produces silence; playing on dograh-ext is the proven path.)

Requires the PBX to be up and dograh connected to ARI, and the loop WAV to be
present in the PBX sounds dir (see scripts/gen_loops.py). ARI is reached at the
host LAN IP — 8088 has no loopback leg (README → Addressing).
"""

import argparse
import base64
import json
import os
import socket
import sys
import time
import urllib.request

# Path to the repo root / .env, resolved relative to this script so it works
# from any cwd.
REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ENV_PATH = os.path.join(REPO_ROOT, ".env")


def env_value(key: str, default: str = "") -> str:
    """Resolve a setting: real env first, then the repo .env, then default."""
    if os.environ.get(key):
        return os.environ[key]
    if os.path.exists(ENV_PATH):
        for line in open(ENV_PATH):
            line = line.strip()
            if line.startswith(f"{key}="):
                val = line.split("=", 1)[1].strip().strip('"').strip("'")
                if val:
                    return val
    return default


def detect_lan_ip() -> str:
    """This host's primary LAN IPv4 (stack convention: central stack-lib.sh).

    The address a service dials is the LAN IP — never loopback (README →
    Addressing).
    """
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        sock.connect(("8.8.8.8", 80))  # picks the default route, sends nothing
        ip = sock.getsockname()[0]
        if ip and not ip.startswith("127."):
            return ip
    except OSError:
        pass
    finally:
        sock.close()
    return ""


def ari_base() -> str:
    """Host-side ARI REST base — the host LAN IP, not loopback.

    8088 is published on the host LAN IP only (README → Addressing): the
    loopback leg went away once dograh — its last client — started dialling the
    LAN IP, so a 127.0.0.1 request would fail against a perfectly healthy PBX.
    DOGRAH_ARI_ENDPOINT wins (the value dograh itself dials), then the shared-PBX
    override (DOGRAH_ARI_HOST:DOGRAH_ARI_PORT), then PJSIP_MEDIA_ADDRESS, then
    the route-selected LAN IP.
    """
    endpoint = env_value("DOGRAH_ARI_ENDPOINT")
    if endpoint:
        return endpoint.rstrip("/") + "/ari"
    host = env_value("DOGRAH_ARI_HOST") or env_value("PJSIP_MEDIA_ADDRESS") or detect_lan_ip()
    if not host:
        sys.exit(
            "ERROR: cannot resolve the host LAN IP — set PJSIP_MEDIA_ADDRESS "
            "(or DOGRAH_ARI_ENDPOINT) in .env"
        )
    if "://" in host:  # a full URL was supplied
        return host.rstrip("/") + "/ari"
    port = env_value("DOGRAH_ARI_PORT", "8088") or "8088"
    return f"http://{host}:{port}/ari"


def ari_password() -> str:
    """Read DOGRAH_ARI_PASSWORD from the environment or the repo .env."""
    password = env_value("DOGRAH_ARI_PASSWORD")
    if not password:
        sys.exit(f"ERROR: DOGRAH_ARI_PASSWORD not set (env or {ENV_PATH})")
    return password


def stasis_app_name() -> str:
    """Read the Stasis app name dograh generated for the ARI config.

    dograh_wire.py persists DOGRAH_STASIS_APP_NAME (dograh_<hex>); falls back
    to the legacy "dograh" (pre-split configs). The dialplan's Stasis() and
    the originate app must both name this app.
    """
    return env_value("DOGRAH_STASIS_APP_NAME", "dograh")


def ari(path: str, method: str = "GET", params: dict | None = None):
    """Call the Asterisk ARI REST endpoint (returns decoded JSON)."""
    auth = base64.b64encode(f"dograh:{ari_password()}".encode()).decode()
    url = f"{ari_base()}{path}"
    if params:
        url += "?" + "&".join(f"{k}={v}" for k, v in params.items())
    req = urllib.request.Request(url, method=method)
    req.add_header("Authorization", f"Basic {auth}")
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            return json.loads(resp.read()) if resp.status == 200 else {}
    except urllib.error.HTTPError as e:
        # 404 is expected once the call hangs up and the channel is gone.
        if e.code != 404:
            print(f"  ARI error: {e}", file=sys.stderr)
        return {}
    except Exception as e:
        print(f"  ARI error: {e}", file=sys.stderr)
        return {}


def first_channel_id(res) -> str | None:
    """Originate returns a channel object or a list — normalize."""
    if isinstance(res, list):
        return res[0]["id"] if res else None
    if isinstance(res, dict) and "id" in res:
        return res["id"]
    return None


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("extension", help="PBX extension (8000/8001/8002)")
    parser.add_argument("sound", help="candidate loop name (e.g. candidate-it)")
    parser.add_argument("timeout", nargs="?", type=int, default=300,
                        help="max seconds to wait for the call to end (default 300)")
    args = parser.parse_args()

    print(f"=== Place call: ext {args.extension}, sound {args.sound} ===")

    # 1. Originate
    res = ari("/channels", method="POST", params={
        "endpoint": f"Local/{args.extension}@dograh-inbound",
        "app": stasis_app_name(),
        "timeout": "30",
    })
    cid = first_channel_id(res)
    if not cid:
        print(f"FAIL: originate returned no channel: {json.dumps(res)[:200]}")
        sys.exit(1)
    print(f"  Caller channel: {cid}")

    # 2. Wait for dograh-ext (WebSocket externalMedia) channel
    ext_chan = None
    for i in range(40):
        time.sleep(1)
        chans = ari("/channels")
        for c in (chans if isinstance(chans, list) else []):
            if c["id"].startswith("dograh-ext-"):
                ext_chan = c["id"]
                print(f"  Found dograh-ext: {ext_chan} (attempt {i+1})")
                break
        if ext_chan:
            break
    if not ext_chan:
        print("WARN: dograh-ext never appeared (is dograh connected to ARI?)")
        sys.exit(1)

    # 3. Wait for dograh-ext to be Up
    for _ in range(30):
        chan = ari(f"/channels/{ext_chan}")
        state = chan.get("state", "unknown") if isinstance(chan, dict) else "unknown"
        if state == "Up":
            print(f"  dograh-ext state: {state}")
            break
        time.sleep(1)

    # 4. Play the candidate loop on dograh-ext
    pb_id = f"playback-{int(time.time())}"
    ari(f"/channels/{ext_chan}/play/{pb_id}", method="POST",
        params={"media": f"sound:{args.sound}"})
    print(f"  Playback started on {ext_chan} → sound:{args.sound}")

    # 5. Wait for the call to end
    start = time.time()
    print(f"  Waiting (timeout {args.timeout}s)...")
    while True:
        elapsed = time.time() - start
        if elapsed > args.timeout:
            print(f"  Timeout after {args.timeout}s")
            break
        chan = ari(f"/channels/{cid}")
        state = chan.get("state", "gone") if isinstance(chan, dict) else "gone"
        if state == "gone":
            print(f"  Call ended at {int(elapsed)}s")
            break
        time.sleep(5)

    print(f"=== Done: ext {args.extension}, sound {args.sound} ===")


if __name__ == "__main__":
    main()
