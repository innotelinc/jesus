#!/usr/bin/env python3
"""Keep the estate's seven zones in Vultr DNS, where a public resolver can reach them.

The zones used to be self-hosted: the registry delegated each name to
`ns1.<zone>`/`ns2.<zone>` with glue pointing at the home connection, and
Technitium on the `cerulean` host answered. That works only while that host is
up, and an in-bailiwick delegation has no second path — when the box went away,
all seven names went SERVFAIL and nothing could bring them back but the box.

So the zones live here now: `ns1.vultr.com`/`ns2.vultr.com` are out-of-bailiwick,
publicly resolvable, and need no glue. The records are the same ones the proxy
map already describes — an apex `A` per zone, `www` as an alias of it, a `CAA`
that names the one CA the edge uses, and the mail records on the sending domain.

This is idempotent: it reads each zone, changes only what is wrong, and reports
what it touched. `--show` writes nothing.

  VULTR_API_KEY=... ./publish-vultr-dns.py --show
  VULTR_API_KEY=... ./publish-vultr-dns.py --apply --ip 45.77.221.158
  ./publish-vultr-dns.py --verify            # asks ns1.vultr.com, no key needed

Delegation is the one thing this cannot do: the registrar (Namecheap) still
lists the old nameservers, and only that account can change them. See
docs/domains.md.
"""
import argparse
import json
import os
import subprocess
import sys
import urllib.error
import urllib.request

ZONES = [
    "telno.services",
    "telno.online",
    "telno.mobi",
    "telno.digital",
    "telno.tel",
    "telno.directory",
    "telno.network",
]
TTL = 300
AUTHORITATIVE = "ns1.vultr.com"
CA = '0 issue "letsencrypt.org"'
SPF = "v=spf1 mx include:spf.mailjet.com ip4:{ip} ~all"
DMARC = ("v=DMARC1; p=quarantine; rua=mailto:dmarc@telno.services; "
         "adkim=r; aspf=r")


def api(path, method="GET", body=None):
    key = os.environ.get("VULTR_API_KEY")
    if not key:
        raise SystemExit("publish-vultr-dns: set VULTR_API_KEY")
    request = urllib.request.Request(
        f"https://api.vultr.com/v2{path}", method=method,
        data=json.dumps(body).encode() if body is not None else None,
        headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            raw = response.read().decode()
            return json.loads(raw) if raw.strip() else {}
    except urllib.error.HTTPError as exc:
        raise SystemExit(f"publish-vultr-dns: {method} {path} -> {exc.code} "
                         f"{exc.read().decode()[:160]}")


def records(zone):
    return api(f"/domains/{zone}/records?per_page=100").get("records", [])


def ensure(zone, wanted, existing):
    """One record, matched on (type, name). Returns 'unchanged'|'created'|'retagged'."""
    match = [r for r in existing
             if r.get("type") == wanted["type"] and r.get("name", "") == wanted["name"]]
    if match:
        held = (match[0].get("data") or "")
        if held == wanted["data"]:
            return "unchanged"
        api(f"/domains/{zone}/records/{match[0]['id']}", "DELETE")
        api(f"/domains/{zone}/records", "POST", wanted)
        return f"retagged ({held[:40]} -> {wanted['data'][:40]})"
    api(f"/domains/{zone}/records", "POST", wanted)
    return "created"


def cmd_show(zones):
    for zone in zones:
        rows = records(zone)
        print(f"{zone} ({len(rows)} record(s))")
        for row in rows:
            print(f"  {row['type']:6} {row.get('name', ''):8} {(row.get('data') or '')[:64]}")
    return 0


def cmd_apply(zones, ip):
    changed = 0
    for zone in zones:
        wanted = [
            {"type": "A", "name": "", "data": ip, "ttl": TTL},
            {"type": "CNAME", "name": "www", "data": zone, "ttl": TTL},
            {"type": "CAA", "name": "", "data": CA, "ttl": TTL},
        ]
        if zone == "telno.services":
            wanted += [
                {"type": "TXT", "name": "", "data": SPF.format(ip=ip), "ttl": TTL},
                {"type": "TXT", "name": "_dmarc", "data": DMARC, "ttl": TTL},
            ]
        # A catch-all that comes with a fresh zone would answer for any name the
        # edge does not list, which is the opposite of a declared map.
        for row in records(zone):
            if row["type"] == "CNAME" and row.get("name") == "*":
                api(f"/domains/{zone}/records/{row['id']}", "DELETE")
                print(f"{zone:17} removed catch-all CNAME *")
        existing = records(zone)
        for want in wanted:
            action = ensure(zone, want, existing)
            print(f"{zone:17} {want['type']:5} {want['name'] or '@':6} {action}")
            changed += action != "unchanged"
    print(f"applied: {changed} change(s) across {len(zones)} zone(s)")
    return 0


def cmd_verify(zones, ip):
    bad = 0
    for zone in zones:
        def ask(rtype, name):
            try:
                out = subprocess.run(["dig", "+short", "+time=4", "+tries=1",
                                      f"@{AUTHORITATIVE}", name, rtype],
                                     capture_output=True, text=True, timeout=20).stdout
                return [l.strip() for l in out.splitlines() if l.strip()]
            except (OSError, subprocess.SubprocessError):
                return []
        apex, alias = ask("A", zone), ask("CNAME", f"www.{zone}")
        ok = ip in apex and bool(alias)
        bad += not ok
        print(f"{zone:17} {'ok' if ok else 'MISMATCH':9} A={','.join(apex) or '-':16} "
              f"www={','.join(alias) or '-'}")
    print(f"{len(zones) - bad}/{len(zones)} zones answer from {AUTHORITATIVE}")
    return 0 if bad == 0 else 1


def main():
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--show", action="store_true", help="read the zones, write nothing")
    group.add_argument("--apply", action="store_true", help="create or correct the records")
    group.add_argument("--verify", action="store_true",
                       help=f"ask {AUTHORITATIVE} for each zone (no API key needed)")
    parser.add_argument("--ip", help="edge address (required with --apply, checked by --verify)")
    args = parser.parse_args()

    if args.apply and not args.ip:
        parser.error("--apply needs --ip")
    if args.verify and not args.ip:
        parser.error("--verify needs --ip (the address the apex must answer with)")
    if args.show:
        return cmd_show(ZONES)
    if args.apply:
        return cmd_apply(ZONES, args.ip)
    return cmd_verify(ZONES, args.ip)


if __name__ == "__main__":
    sys.exit(main())
