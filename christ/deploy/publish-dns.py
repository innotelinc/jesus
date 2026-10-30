#!/usr/bin/env python3
"""Point the estate's public names at the box that actually serves them.

Cerulean's Technitium is authoritative for every `telno.*` zone, so a record
written here *is* the public answer — there is no second provider to wait on.
That is why this is a two-line change and not a migration.

Each zone needs two records to serve over HTTPS, not one: the apex `A` the edge
answers on, and `www` as an alias of it. The proxy lists `<zone>` and
`www.<zone>` in one site block and Caddy requests a single certificate covering
both names, so a `www` that resolves nowhere fails the certificate for the apex
too. `--apply` writes both, and `--show` says which is missing.

Credentials come from Vault (`cerulean/technitium`, keys `url`, `user`,
`password`), never from this file and never from a committed `.env`. Point
`VAULT_ADDR`/`VAULT_TOKEN_FILE` at the store and the rest is discovered:

  VAULT_TOKEN_FILE=/opt/christ/cerulean/data/vault/token/cerulean.token \
    ./publish-dns.py --show

  ./publish-dns.py --apply --ip 45.77.221.158   # apex A and www per zone
  ./publish-dns.py --verify --ip 45.77.221.158  # public DNS, then TLS at the box

`--show` and `--verify` never write. `--apply` touches the apex `A` and the
`www` alias only (and prints the prior value so the change can be put back by
hand). `--verify` needs no Technitium credential: it asks public resolvers over
DNS-over-HTTPS, so it works from a machine with no `dig` on it.
"""
import argparse
import json
import os
import socket
import ssl
import subprocess
import sys
import urllib.parse
import urllib.request

ZONES = [
    "telno.services",
    "telno.digital",
    "telno.directory",
    "telno.mobi",
    "telno.network",
    "telno.online",
    "telno.tel",
]
DEFAULT_TTL = "300"


def env(name, default=None):
    value = os.environ.get(name)
    return value if value not in (None, "") else default


def http_json(url, method="GET", headers=None, timeout=25):
    request = urllib.request.Request(url, data=b"" if method == "POST" else None,
                                     method=method, headers=headers or {})
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.loads(response.read().decode())


def vault_secret():
    """The Technitium credential, from Vault when one is configured."""
    address = env("VAULT_ADDR")
    token = env("VAULT_TOKEN")
    token_file = env("VAULT_TOKEN_FILE")
    if not address:
        return {}
    if not token and token_file:
        try:
            with open(token_file, encoding="utf-8") as handle:
                token = handle.read().strip()
        except OSError as exc:
            print(f"publish-dns: cannot read {token_file}: {exc}", file=sys.stderr)
            return {}
    if not token:
        return {}
    prefix = env("VAULT_PREFIX", "cerulean")
    path = env("VAULT_TECHNITIUM_PATH", "technitium")
    body = http_json(f"{address.rstrip('/')}/v1/{prefix}/data/{path}",
                     headers={"X-Vault-Token": token})
    return (body.get("data") or {}).get("data") or {}


class Technitium:
    def __init__(self, url, user, password):
        self.url = url.rstrip("/")
        query = urllib.parse.urlencode({"user": user, "pass": password,
                                        "includeInfo": "false"})
        body = http_json(f"{self.url}/api/user/login?{query}", method="POST")
        if body.get("status") != "ok":
            raise SystemExit(f"publish-dns: Technitium login failed: "
                             f"{body.get('errorMessage') or body}")
        self.token = body["token"]

    def get(self, path, **params):
        query = urllib.parse.urlencode({"token": self.token, **params})
        return http_json(f"{self.url}/api/{path}?{query}")

    def zones(self):
        return [z.get("name", "").rstrip(".").lower()
                for z in (self.get("zones/list").get("response") or {}).get("zones") or []]

    def records(self, zone, domain=None):
        """Records at one name. Without `domain` this is the apex — and only the
        apex, which is why `www` has its own check below."""
        body = self.get("zones/records/get", domain=domain or zone, zone=zone)
        if body.get("status") != "ok":
            raise SystemExit(f"publish-dns: cannot read {zone}: "
                             f"{body.get('errorMessage') or body}")
        return (body.get("response") or {}).get("records") or []

    @staticmethod
    def apex(records, zone):
        return [r for r in records
                if str(r.get("name", "")).rstrip(".").lower() == zone]

    def set_www(self, zone, ttl=DEFAULT_TTL):
        """Create or correct `www.<zone>` as an alias of the apex."""
        name = f"www.{zone}"
        here = [r for r in self.records(zone, name)
                if str(r.get("name", "")).rstrip(".").lower() == name]
        aliases = [r for r in here if r.get("type") == "CNAME"]
        if aliases:
            current = (aliases[0].get("rData") or {}).get("cname", "").rstrip(".").lower()
            if current == zone:
                return "unchanged", current
            self.get("zones/records/delete", domain=name, zone=zone, type="CNAME",
                     cname=current)
            action, previous = "replace", current
        else:
            # An `A` here would answer for `www` but pin it to one address; the
            # alias follows the apex, which is what the edge's block expects.
            for row in here:
                if row.get("type") == "A":
                    self.get("zones/records/delete", domain=name, zone=zone, type="A",
                             ipAddress=(row.get("rData") or {}).get("ipAddress"))
            action, previous = "add", None
        body = self.get("zones/records/add", domain=name, zone=zone, type="CNAME",
                        cname=zone, ttl=ttl)
        if body.get("status") != "ok":
            raise SystemExit(f"publish-dns: {action} {name} failed: "
                             f"{body.get('errorMessage') or body}")
        return action, previous

    def set_a(self, zone, ip, ttl=DEFAULT_TTL):
        """Create or update the zone apex A record; returns (action, previous)."""
        apex = self.apex(self.records(zone), zone)
        addresses = [r for r in apex if r.get("type") == "A"]
        if not addresses:
            body = self.get("zones/records/add", domain=zone, zone=zone, type="A",
                            ipAddress=ip, ttl=ttl)
            action, previous = "add", None
        else:
            previous = (addresses[0].get("rData") or {}).get("ipAddress")
            if previous == ip:
                return "unchanged", previous
            body = self.get("zones/records/update", domain=zone, zone=zone, type="A",
                            ipAddress=ip, ttl=ttl)
            action = "update"
            if body.get("status") != "ok":
                # Technitium will not match an apex record through `update`
                # ("the record does not exists to be updated") even though the
                # record it just listed is right there. Deleting the old address
                # and adding the new one is the same edit, and the only one the
                # API accepts at a zone apex.
                removed = self.get("zones/records/delete", domain=zone, zone=zone,
                                   type="A", ipAddress=previous)
                if removed.get("status") != "ok":
                    raise SystemExit(f"publish-dns: cannot replace {zone}: "
                                     f"{removed.get('errorMessage') or removed}")
                body = self.get("zones/records/add", domain=zone, zone=zone,
                                type="A", ipAddress=ip, ttl=ttl)
                action = "replace"
        if body.get("status") != "ok":
            raise SystemExit(f"publish-dns: {action} {zone} failed: "
                             f"{body.get('errorMessage') or body}")
        return action, previous


def connect():
    secret = vault_secret()
    url = env("TECHNITIUM_URL") or secret.get("url") or "http://127.0.0.1:5380"
    user = env("TECHNITIUM_USER") or secret.get("user") or "admin"
    password = env("TECHNITIUM_ADMIN_PASSWORD") or secret.get("password")
    if not password:
        raise SystemExit("publish-dns: no Technitium password - set VAULT_ADDR/"
                         "VAULT_TOKEN_FILE or TECHNITIUM_ADMIN_PASSWORD")
    source = "vault" if secret.get("password") else "env"
    print(f"publish-dns: {url} as {user} (password from {source})")
    return Technitium(url, user, password)


def describe(record):
    data = record.get("rData") or {}
    value = data.get("ipAddress") or data.get("cname") or data.get("text") or \
        data.get("exchange") or data.get("nameServer") or ""
    return f"{record.get('type')}\t{value}\t{record.get('ttl')}"


def cmd_show(client):
    hosted = set(client.zones())
    print(f"zones hosted here: {len(hosted)}")
    for zone in ZONES:
        if zone not in hosted:
            print(f"{zone:18} NOT HOSTED HERE")
            continue
        rows = client.apex(client.records(zone), zone)
        if not rows:
            print(f"{zone:18} apex empty")
            continue
        first = rows[0]
        print(f"{zone:18} {describe(first)}   (+{len(rows) - 1} more at apex)")
        for record in rows[1:]:
            print(f"{'':18}   {describe(record)}")

    # The edge answers for `www.<zone>` in the same site block as the apex, and
    # Caddy asks for one certificate covering both. A missing `www` fails that
    # request for the apex too, so it is worth stating per zone.
    aliased = 0
    for zone in ZONES:
        if zone not in hosted:
            continue
        name = f"www.{zone}"
        www = [r for r in client.records(zone, name)
               if str(r.get("name", "")).rstrip(".").lower() == name]
        if www:
            aliased += 1
            print(f"{'':18}   www: {describe(www[0])}")
        else:
            print(f"{'':18}   www: MISSING - the edge lists it, so its certificate fails")
    print(f"zones with a www alias: {aliased}/{len(ZONES)}")
    return 0


def cmd_apply(client, ip):
    hosted = set(client.zones())
    missing = [z for z in ZONES if z not in hosted]
    for zone in missing:
        print(f"{zone:18} SKIP - not hosted on this server", file=sys.stderr)
    changed = 0
    for zone in ZONES:
        if zone not in hosted:
            continue
        action, previous = client.set_a(zone, ip)
        changed += action != "unchanged"
        print(f"{zone:18} apex {action:9} {previous or '-'} -> {ip}")
        action, previous = client.set_www(zone)
        changed += action != "unchanged"
        print(f"{zone:18} www  {action:9} {previous or '-'} -> {zone}")
    print(f"applied: {changed} change(s); {len(missing)} zone(s) not here")
    return 0 if not missing else 1


def doh(host, server):
    """The same question over DNS-over-HTTPS, for hosts with no `dig`."""
    endpoint = {"1.1.1.1": "https://cloudflare-dns.com/dns-query",
                "8.8.8.8": "https://dns.google/resolve"}.get(
                    server, f"https://{server}/dns-query")
    url = f"{endpoint}?name={urllib.parse.quote(host)}&type=A"
    try:
        body = http_json(url, headers={"Accept": "application/dns-json"})
    except Exception:                                        # noqa: BLE001 — a dead zone is an empty answer
        return []
    return [a["data"] for a in body.get("Answer") or [] if a.get("type") == 1]


def resolve(host, server=None):
    """One A answer, by asking a specific resolver when one is named."""
    if server:
        try:
            out = subprocess.run(["dig", "+short", "+time=3", "+tries=1", host, "A",
                                  f"@{server}"], capture_output=True, text=True,
                                 timeout=15).stdout
            found = [line.strip() for line in out.splitlines()
                     if line.strip() and not line.strip().endswith(".")]
            if found:
                return found
        except (OSError, subprocess.SubprocessError):
            pass
        return doh(host, server)
    try:
        return sorted({info[4][0] for info in socket.getaddrinfo(host, 443)})
    except OSError:
        return []


def certificate(host, ip=None):
    """The certificate a browser would see. With `ip` the handshake is pinned to
    the box, so this answers "would the edge serve this name" before the public
    record exists — with the certificate's own name check still in force."""
    context = ssl.create_default_context()
    try:
        with socket.create_connection((ip or host, 443), timeout=8) as raw:
            with context.wrap_socket(raw, server_hostname=host) as tls:
                cert = tls.getpeercert()
                issuer = dict(x[0] for x in cert.get("issuer", ()))
                return f"{issuer.get('organizationName', '?')} exp {cert.get('notAfter')}"
    except Exception as exc:                                  # noqa: BLE001 — reported, not raised
        return f"FAIL {type(exc).__name__}: {exc}"


def cmd_verify(ip, resolvers):
    answers = {}
    for server in resolvers:
        print(f"- via {server}")
        for zone in ZONES:
            apex, alias = resolve(zone, server), resolve(f"www.{zone}", server)
            answers.setdefault(zone, []).extend(apex)
            answers.setdefault(f"www.{zone}", []).extend(alias)
            mark = "ok" if ip in apex else "MISMATCH"
            print(f"  {zone:18} apex {','.join(apex) or '(no answer)':16} {mark:8}"
                  f" www {','.join(alias) or '(no answer)'}")
    print("- end to end")
    bad = 0
    for zone in ZONES:
        public = set(answers.get(zone) or [])
        alias = set(answers.get(f"www.{zone}") or [])
        served = resolve(zone)
        ok = ip in public and ip in served and ip in alias
        bad += not ok
        print(f"  {zone:18} {'ok' if ok else 'MISMATCH':9} "
              f"tls: {certificate(zone, ip)}")
    print(f"{len(ZONES) - bad}/{len(ZONES)} names answer publicly")
    return 0 if bad == 0 else 1


def main():
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--show", action="store_true", help="read the zones, write nothing")
    group.add_argument("--apply", action="store_true", help="set the apex A and www records")
    group.add_argument("--verify", action="store_true", help="check the public answers")
    parser.add_argument("--ip", help="address to publish (required with --apply)")
    parser.add_argument("--resolver", action="append",
                        help="resolver to ask with --verify (repeatable)")
    args = parser.parse_args()

    if args.verify:
        # Verification is about what the world sees, so it must work with the
        # authoritative host down — which is the case when it matters most.
        return cmd_verify(args.ip, args.resolver or ["1.1.1.1", "8.8.8.8"])

    client = connect()
    if args.show:
        return cmd_show(client)
    if not args.ip:
        parser.error("--apply needs --ip")
    return cmd_apply(client, args.ip)


if __name__ == "__main__":
    sys.exit(main())
