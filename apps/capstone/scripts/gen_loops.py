#!/usr/bin/env python3
"""Generate candidate answer loops for each interview track via Kokoro TTS.

Produces <out_dir>/candidate-{it,devops,sql}.wav — a single WAV of the
candidate's lines with a 4s silence gap between each answer, so the loop
sounds like the candidate replying to the agent's questions.

Then copies each loop into the PBX container's sounds dir
(/var/lib/asterisk/sounds/en) and web root (/var/www/html) so Asterisk can
play it via ARI `sound:` media and serve it over HTTP.

Key gotcha baked in: Kokoro emits 24 kHz WAVs, but Asterisk's `sound:`
playback expects 8 kHz — so we downsample with ffmpeg before copying.

Usage:
    python3 scripts/gen_loops.py [--out-dir /tmp/answers] [--pbx pbx-freepbx]
"""

import argparse
import json
import os
import shutil
import struct
import subprocess
import sys
import tempfile
import urllib.request

KOKORO_URL = "http://127.0.0.1:8880/v1/audio/speech"
VOICE = "am_michael"  # male voice for candidate

# Extension → track routing (matches [dograh-inbound] in extensions_custom.conf)
TRACKS = {
    "it": [
        "Hello, yes this is Alex. I'm ready for my IT Help Desk interview.",
        "Well, the first thing I would do is ask the user if they've tried restarting their computer. That resolves a surprising number of issues.",
        "For network connectivity problems, I'd have them check if the Ethernet cable is plugged in and the WiFi is turned on. Then I'd run ipconfig to check their IP address.",
        "If they can't connect to the VPN, I'd verify their credentials first, check if the VPN client is installed, and make sure their internet is working before troubleshooting the VPN configuration.",
        "For a printer not working, I'd check if it's powered on, connected to the network, and if there are any error lights. Then I'd check the print queue for stuck jobs.",
        "When escalating to Tier 2, I always make sure to document everything: the user's issue, what troubleshooting steps I've already taken, any error messages, and the user's contact information.",
        "I think strong communication is just as important as technical knowledge. You need to explain things clearly without jargon.",
        "That's a good question. I'd prioritize based on impact. If multiple people are affected, that takes precedence over a single user issue.",
        "Thank you for the opportunity. I really enjoyed discussing these scenarios with you.",
    ],
    "devops": [
        "Hello, I'm Marcus. I'm ready for the DevOps interview.",
        "For CI/CD, I'd use a pipeline that runs linting, unit tests, integration tests, and then deploys to staging before production. GitHub Actions or GitLab CI both work well.",
        "Containerization with Docker is essential. It ensures consistency between development and production environments. You define everything in the Dockerfile.",
        "For orchestration, Kubernetes handles scaling, self-healing, and rolling updates. But for smaller setups, Docker Compose or Nomad might be enough.",
        "Infrastructure as Code with Terraform means you version your infrastructure the same way you version your application code. No more snowflake servers.",
        "Monitoring is critical. I'd set up Prometheus for metrics, Grafana for dashboards, and something like PagerDuty for alerting. You need to know about problems before your users do.",
        "For secrets management, never hardcode credentials. Use HashiCorp Vault, or at minimum environment variables with a .env file that's gitignored.",
        "Rollback strategy: always have a plan to revert. Blue-green deployments or canary releases let you switch back instantly if something goes wrong.",
        "Thank you, those were great questions. I appreciate the chance to walk through these scenarios.",
    ],
    "sql": [
        "Hi, I'm Lena. Let's talk databases.",
        "A JOIN combines rows from two or more tables based on a related column. INNER JOIN returns only matching rows, LEFT JOIN returns all rows from the left table even if there's no match.",
        "An index speeds up SELECT queries by creating a data structure that the database can search quickly, like a B-tree. But they slow down INSERTs and UPDATEs because the index needs to be maintained.",
        "Normalization reduces data redundancy by organizing tables. First normal form eliminates repeating groups, second removes partial dependencies, third removes transitive dependencies.",
        "For a slow query, I'd start with EXPLAIN ANALYZE to see the execution plan. Look for sequential scans on large tables, missing indexes, or poorly written JOINs.",
        "A transaction groups multiple operations into an atomic unit. If any statement fails, the whole transaction rolls back. ACID properties guarantee consistency.",
        "A subquery is a query nested inside another query. They can be in SELECT, FROM, or WHERE clauses. Sometimes you can rewrite a subquery as a JOIN for better performance.",
        "Window functions like ROW_NUMBER, RANK, and LAG let you perform calculations across a set of rows related to the current row, without collapsing them like GROUP BY does.",
        "Thank you. Database design is something I'm really passionate about.",
    ],
}

GAP_SECONDS = 4  # silence between candidate answers (agent speaks in between)


def tts_line(text: str) -> bytes:
    """Call Kokoro TTS → WAV bytes (24 kHz mono 16-bit)."""
    body = json.dumps({
        "input": text,
        "model": "kokoro",
        "voice": VOICE,
        "response_format": "wav",
    }).encode()
    req = urllib.request.Request(
        KOKORO_URL, data=body, headers={"Content-Type": "application/json"}
    )
    with urllib.request.urlopen(req, timeout=120) as resp:
        return resp.read()


def wav_params(raw: bytes) -> tuple[int, int, int]:
    """Return (channels, sample_width, framerate) from a WAV header."""
    # fmt chunk (starts at offset 20): audio format, channels, rate,
    # byterate, block align, bits per sample.
    afmt, channels, rate, _, _, bits = struct.unpack_from("<HHIIHH", raw, 20)
    return channels, bits // 8, rate


def data_chunk(raw: bytes) -> bytes:
    """Return the PCM bytes of the RIFF 'data' chunk.

    Kokoro WAVs carry a LIST/INFO metadata chunk between the fmt and data
    chunks, so the PCM does NOT start at the fixed 44-byte offset. Walk the
    chunk list to find the real data chunk instead.
    """
    pos = 12  # skip RIFF header + WAVE id
    while pos + 8 <= len(raw):
        cid = raw[pos:pos + 4]
        size = struct.unpack_from("<I", raw, pos + 4)[0]
        if cid == b"data":
            return raw[pos + 8:pos + 8 + size]
        pos += 8 + size + (size & 1)  # chunks are word-aligned
    return raw[44:]  # fallback: plain 44-byte header WAV


def compose_loop(track: str, lines: list[str], out_dir: str) -> str:
    """Generate each line, concatenate with silence gaps, write a single WAV."""
    chunks: list[bytes] = []
    nch = sw = rate = None
    for i, line in enumerate(lines):
        print(f"  [{track}] line {i+1}/{len(lines)}: {line[:55]}...")
        wav = tts_line(line)
        chunks.append(wav)
        nch, sw, rate = wav_params(wav)
        # Silence gap (agent speaks in between candidate answers)
        chunks.append(b"\x00" * (rate * sw * nch * GAP_SECONDS))

    # Concatenate raw PCM (strip each WAV header, skipping any LIST chunk)
    all_pcm = bytearray()
    for chunk in chunks:
        all_pcm += data_chunk(chunk)

    data_size = len(all_pcm)
    header = struct.pack(
        "<4sI4s4sIHHIIHH4sI",
        b"RIFF", 36 + data_size,
        b"WAVE", b"fmt ", 16,
        1, nch, rate, rate * nch * sw, nch * sw, sw * 8,
        b"data", data_size,
    )
    os.makedirs(out_dir, exist_ok=True)
    out_path = os.path.join(out_dir, f"candidate-{track}.wav")
    with open(out_path, "wb") as f:
        f.write(header + all_pcm)
    print(f"    → wrote {out_path} ({data_size} bytes PCM, {rate} Hz)")
    return out_path


def downsample_to_8k(src: str) -> str:
    """Downsample to 8 kHz mono 16-bit (Asterisk `sound:` requirement)."""
    if not shutil.which("ffmpeg"):
        print("ERROR: ffmpeg not found — needed to downsample to 8 kHz", file=sys.stderr)
        sys.exit(1)
    tmp = tempfile.mktemp(suffix=".wav")
    subprocess.run(
        ["ffmpeg", "-y", "-loglevel", "error",
         "-i", src, "-ar", "8000", "-ac", "1", "-sample_fmt", "s16", "-f", "wav", tmp],
        check=True,
    )
    os.replace(tmp, src)
    return src


def copy_to_pbx(path: str, pbx: str) -> None:
    """Copy a WAV into the PBX sounds dir and web root."""
    sounds = "/var/lib/asterisk/sounds/en"
    www = "/var/www/html"
    base = os.path.basename(path)
    subprocess.run(["docker", "exec", pbx, "mkdir", "-p", sounds, www], check=True)
    subprocess.run(["docker", "cp", path, f"{pbx}:{sounds}/{base}"], check=True)
    subprocess.run(["docker", "cp", path, f"{pbx}:{www}/{base}"], check=True)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out-dir", default="/tmp/answers",
                        help="where to write the generated WAVs (default: /tmp/answers)")
    parser.add_argument("--pbx", default="pbx-freepbx",
                        help="PBX container name (default: pbx-freepbx)")
    parser.add_argument("--tracks", nargs="+", choices=list(TRACKS),
                        help="only generate these tracks (default: all)")
    args = parser.parse_args()

    tracks = args.tracks or list(TRACKS)
    manifest = {}
    for track in tracks:
        path = compose_loop(track, TRACKS[track], args.out_dir)
        downsample_to_8k(path)
        print(f"    → downsampled to 8 kHz")
        manifest[track] = {"path": path, "lines": len(TRACKS[track])}

    manifest_path = os.path.join(args.out_dir, "manifest.json")
    with open(manifest_path, "w") as f:
        json.dump(manifest, f, indent=2)
    print(f"\nManifest → {manifest_path}")

    for track in tracks:
        path = manifest[track]["path"]
        try:
            copy_to_pbx(path, args.pbx)
            print(f"  Copied {track} → PBX sounds dir + web root")
        except subprocess.CalledProcessError as e:
            print(f"  WARN: could not copy {track} into {args.pbx}: {e}")

    print("\nDone. Loops ready for playback via scripts/place_call.py.")


if __name__ == "__main__":
    main()
