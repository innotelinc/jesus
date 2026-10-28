#!/usr/bin/env python3
"""Is the Capstone image set available for arm64, and how big is it?

`docker compose up` on an arm64 host fails image by image, which hides the
shape of the problem. This asks the registries directly, for every image in
docker-compose.yml, and reports three things per image:

  arm64   — linux/arm64 is published (multi-arch index, or a single-arch
            arm64 manifest)
  amd64   — linux/amd64 is published
  size    — the compressed size of the arm64 image, or of amd64 when arm64 is
            missing (what it would cost to build/port)

Images that are not published at all (`capstone-*:local` builds, the innotelinc
private ghcr images) are reported as such rather than counted as portable.

Usage:
    python3 deploy/arm64-audit.py                  # all images in compose
    python3 deploy/arm64-audit.py --json
    python3 deploy/arm64-audit.py --ram 3 --disk 32   # compare with a device

Only stdlib is used, and only anonymous registry access: a private image shows
as `auth required`, which is itself the answer (you must build it for arm64).
"""

import argparse
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request

COMPOSE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "docker-compose.yml")

ACCEPT = ", ".join([
    "application/vnd.oci.image.index.v1+json",
    "application/vnd.docker.distribution.manifest.list.v2+json",
    "application/vnd.oci.image.manifest.v1+json",
    "application/vnd.docker.distribution.manifest.v2+json",
])
INDEX_TYPES = (
    "application/vnd.oci.image.index.v1+json",
    "application/vnd.docker.distribution.manifest.list.v2+json",
)
TIMEOUT = 25


def images_from_compose(path):
    """Unique image refs, with ${VAR:-default} resolved to the default."""
    seen = []
    var = re.compile(r"\$\{[A-Za-z_][A-Za-z0-9_]*:-([^}]*)\}")
    with open(path, encoding="utf-8") as fh:
        for line in fh:
            m = re.match(r"\s+image:\s*(\S+)\s*$", line)
            if not m:
                continue
            ref = var.sub(r"\1", m.group(1)).strip().strip("'\"")
            if ref and ref not in seen:
                seen.append(ref)
    return seen


def split_ref(ref):
    """('registry', 'repository') for a docker image reference."""
    name, _, tag = ref.partition(":")
    if "/" in name and ("." in name.split("/")[0] or ":" in name.split("/")[0]):
        registry, _, repo = name.partition("/")
    elif name.startswith(("ghcr.io", "quay.io", "gcr.io", "docker.io", "registry.k8s.io")):
        registry, _, repo = name.partition("/")
    else:
        registry, repo = "docker.io", name
    if registry == "docker.io" and "/" not in repo:
        repo = f"library/{repo}"
    registry = {"docker.io": "registry-1.docker.io", "index.docker.io": "registry-1.docker.io"}.get(registry, registry)
    return registry, repo, tag or "latest"


def token_for(registry, repo):
    """Anonymous pull token, or '' when the registry serves manifests openly."""
    if registry == "registry-1.docker.io":
        url = f"https://auth.docker.io/token?service=registry.docker.io&scope=repository:{repo}:pull"
    elif registry == "ghcr.io":
        url = f"https://ghcr.io/token?scope=repository:{repo}:pull&service=ghcr.io"
    elif registry == "quay.io":
        url = f"https://quay.io/v2/auth?service=quay.io&scope=repository:{repo}:pull"
    else:
        return ""
    try:
        with urllib.request.urlopen(url, timeout=TIMEOUT) as r:
            return json.load(r).get("token") or ""
    except (urllib.error.URLError, OSError, ValueError):
        return ""


def get_manifest(registry, repo, ref, token, accept=ACCEPT):
    url = f"https://{registry}/v2/{repo}/manifests/{ref}"
    req = urllib.request.Request(url, headers={"Accept": accept, "User-Agent": "capstone-arm64-audit"})
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
        return r.headers.get("Content-Type", ""), json.load(r)


def layer_bytes(manifest):
    return sum(l.get("size", 0) for l in manifest.get("layers", []))


def audit(ref):
    registry, repo, tag = split_ref(ref)
    out = {"image": ref, "registry": registry, "arm64": False, "amd64": False,
           "size": 0, "size_for": "", "note": ""}
    if ref.endswith(":local") or "/" not in ref and ":" not in ref and ref.startswith("capstone-"):
        out["note"] = "local build — must be rebuilt for arm64"
        return out
    token = token_for(registry, repo)
    try:
        ctype, doc = get_manifest(registry, repo, tag, token)
    except urllib.error.HTTPError as e:
        if e.code in (401, 403):
            out["note"] = "auth required (private) — rebuild or authenticate to check"
        elif e.code == 404:
            out["note"] = "not published (local build) — must be rebuilt for arm64"
        else:
            out["note"] = f"HTTP {e.code}"
        return out
    except (urllib.error.URLError, OSError, ValueError) as e:
        out["note"] = f"unreachable: {getattr(e, 'reason', e)}"
        return out

    if "index" in ctype or "list" in ctype:
        by_arch = {}
        for m in doc.get("manifests", []):
            p = m.get("platform") or {}
            if p.get("os") != "linux":
                continue
            arch = p.get("architecture")
            by_arch.setdefault(arch, m)
        out["arm64"] = "arm64" in by_arch
        out["amd64"] = "amd64" in by_arch
        pick = by_arch.get("arm64") or by_arch.get("amd64")
        if pick:
            out["size_for"] = "arm64" if "arm64" in by_arch else "amd64"
            try:
                _, sub = get_manifest(registry, repo, pick["digest"], token)
                out["size"] = layer_bytes(sub)
            except (urllib.error.HTTPError, urllib.error.URLError, OSError, ValueError):
                out["size"] = pick.get("size", 0)  # index entry size as a floor
        if not out["arm64"]:
            out["note"] = "multi-arch, but no arm64 variant"
        return out

    # A single-arch manifest: ask the config blob what architecture it is.
    try:
        _, cfg = get_manifest(registry, repo, doc["config"]["digest"], token,
                             accept="application/vnd.oci.image.config.v1+json,"
                                    "application/vnd.docker.container.image.v1+json")
        arch = (cfg.get("architecture") or "").lower()
    except (urllib.error.HTTPError, urllib.error.URLError, OSError, KeyError, ValueError):
        arch = ""
    out["arm64"] = arch in ("arm64", "aarch64")
    out["amd64"] = arch in ("amd64", "x86_64")
    out["size"] = layer_bytes(doc)
    out["size_for"] = "arm64" if out["arm64"] else ("amd64" if out["amd64"] else arch or "?")
    out["note"] = f"single-arch ({arch or 'unknown'})"
    return out


def human(n):
    for unit in ("B", "KiB", "MiB", "GiB", "TiB"):
        if n < 1024 or unit == "TiB":
            return f"{n:.1f} {unit}" if unit != "B" else f"{n} B"
        n /= 1024


def main(argv=None):
    ap = argparse.ArgumentParser(description="arm64 availability + size audit")
    ap.add_argument("--compose", default=COMPOSE)
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--ram", type=float, default=0, help="target device RAM in GiB")
    ap.add_argument("--disk", type=float, default=0, help="target device free disk in GiB")
    args = ap.parse_args(argv)

    if hasattr(sys.stdout, "reconfigure"):  # Windows consoles default to cp1252
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")

    refs = images_from_compose(args.compose)
    rows = []
    if not args.json:
        print(f"auditing {len(refs)} images from {os.path.basename(args.compose)} …\n")
    for ref in refs:
        row = audit(ref)
        rows.append(row)

    arm = [r for r in rows if r["arm64"]]
    need_build = [r for r in rows if not r["arm64"]]
    total = sum(r["size"] for r in rows if r["arm64"])
    unpullable = sum(r["size"] for r in need_build if r["size"])

    if args.json:
        print(json.dumps({
            "images": len(rows),
            "arm64_available": len(arm),
            "needs_port": len(need_build),
            "available_bytes": total,
            "unavailable_bytes": unpullable,
            "rows": rows,
        }, indent=2))
        return 0

    print(f"{'IMAGE':<58} {'arm64':<6} {'amd64':<6} {'SIZE':>10}  NOTE")
    print("-" * 104)
    for r in rows:
        size = human(r["size"]) if r["size"] else "—"
        print(f"{r['image'][:57]:<58} {('yes' if r['arm64'] else 'no'):<6} "
              f"{('yes' if r['amd64'] else 'no'):<6} {size:>10}  {r['note']}")

    print("\n" + "=" * 104)
    print(f"{len(arm)}/{len(rows)} images publish linux/arm64; {len(need_build)} need a port or rebuild.")
    print(f"Pullable arm64 layers: {human(total)}" + (f" (+{human(unpullable)} of amd64-only images to replace)" if unpullable else ""))
    print("On-disk: layered images unpack to roughly 2–3× their compressed size, plus volumes for")
    print("Postgres, MariaDB, MinIO recordings, Grist and n8n.")

    if args.ram or args.disk:
        print("\nAgainst the target device:")
        if args.ram:
            print(f"  RAM   {args.ram} GiB — Capstone alone is measured at 5.84 GiB "
                  f"(docs/host-move.md); {'does NOT fit' if args.ram < 5.84 else 'fits the measured floor'}")
        if args.disk:
            fits = (total / 1024**3) * 2.5 < args.disk
            print(f"  disk  {args.disk} GiB free — arm64 pull is {human(total)}, unpacked ~"
                  f"{human(total * 2.5)}; {'fits' if fits else 'does NOT fit'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
