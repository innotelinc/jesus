#!/usr/bin/env python3
"""authentik_bootstrap.py — provision the Cerulean Authentik objects the Capstone stack needs.

Idempotent: safe to re-run, every step checks before writing.

What it creates (in the Authentik instance at AUTHENTIK_PUBLIC_URL, default
https://auth.capstone.innotel.us):

  1. Proxy provider  "Cerulean NPM Forward Auth"
       mode=forward_domain (single), external_host=https://auth.<NPM_BASE_DOMAIN>,
       cookie_domain=<NPM_BASE_DOMAIN> — one domain-level provider covers every
       *.capstone.innotel.us proxy host; the embedded outpost matches requests
       by X-Forwarded-Host.
  2. Application     "capstone-npm-forward-auth" bound to that provider.
  3. Outpost membership — the provider is added to the embedded outpost so its
       /outpost.goauthentik.io/auth/nginx endpoint serves every host.
  4. Embedded outpost host — authentik_host / authentik_host_browser are pinned
       to https://auth.<NPM_BASE_DOMAIN>, the SAME vhost the provider serves
       from. The embedded outpost ignores authentik_host_browser
       (goauthentik/authentik#5922), so a stale authentik_host (e.g. the global
       auth.innotel.us) sends browsers to an Authentik origin that does not own
       the provider → /application/o/authorize/ rejects the redirect_uri and the
       user sees "Redirect URI Error".
  5. Stack groups — one Authentik Group per product (Capstone, Cerulean, Zeus,
       …) with every application tied to its stack through Application.group.
       The group objects exist so membership/roles can be layered on later
       without renaming anything; the app tie is what groups the portal tiles.

This mirrors what scripts/npm-proxy-hosts.py expects when it injects the
auth_request nginx snippet into each NPM proxy host (Cerulean SSO for FreePBX/
AvantFAX, dograh, n8n, Grist, SigNoz, OmniRoute and the Workflow Studio).

Two ways to run:

  a) With the Authentik API (token auth):
       AUTHENTIK_TOKEN must be a valid token of a user with the
       authentik_admin role (create one: Directory → Tokens & App Passwords).
       python3 scripts/authentik_bootstrap.py

  b) Without a token (container shell — used by scripts/setup.sh):
       docker exec -i cerulean-authentik ak shell < <(python3 scripts/authentik_bootstrap.py --emit-shell)
     or simply run this script inside the server container:
       docker exec -i cerulean-authentik python3 - < scripts/authentik_bootstrap.py --shell

Environment:
  AUTHENTIK_PUBLIC_URL   base URL of the Authentik instance
                         (default https://auth.capstone.innotel.us)
  AUTHENTIK_TOKEN        API token (mode a only)
  NPM_BASE_DOMAIN        base domain (default capstone.innotel.us)
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent

PROVIDER_NAME = "Cerulean NPM Forward Auth"
APP_SLUG = "capstone-npm-forward-auth"
OUTPOST_NAME = "authentik Embedded Outpost"

# Users who must keep access to a stack even after enforcement. Internal and
# service accounts are added automatically (see KEEP_ACCESS_USER_TYPES), so this
# only lists EXTERNAL humans — the operators who actually sign in.
STACK_KEEP_ACCESS: dict[str, list[str]] = {
    "Capstone": ["justin"],
}

# Groups that already express "who owns this stack" — their members seed the
# stack group, so enforcement preserves the intent that was being carried by the
# older per-product admin groups.
STACK_LEGACY_GROUPS: dict[str, list[str]] = {
    "Cerulean": ["cerulean-platform"],
    "Signara": ["signara-admins"],
    "PLUTUS": ["plutus-admins"],
    "Rizz Aura": ["rizz-aura-admins"],
}

# User types granted access to every stack. Authentik's application policy
# engine has NO superuser bypass (verified against
# /api/v3/core/applications/<slug>/check_access/ with a group binding: a
# superuser outside the bound group gets passing=false), so superusers and
# machine identities must be seeded explicitly or enforcement locks them out.
KEEP_ACCESS_USER_TYPES = {"internal", "service_account", "internal_service_account"}


# Stack registry: the Authentik group each product's applications belong to.
# Application.group is Authentik's native "which product does this app belong
# to" field (it groups the portal tiles); the group is ALSO created as a real
# Group object so membership/roles can be layered on later without renaming.
STACKS: list[tuple[str, list[str]]] = [
    ("Capstone", ["capstone-dashboard", "capstone-npm-forward-auth"]),
    ("Cerulean", ["cerulean"]),
    ("Zeus", ["zeus"]),
    ("Onyx", ["onyx-platform"]),
    ("Magnate", ["magnate-admin"]),
    ("Monarch", ["monarch"]),
    ("Signara", ["signara"]),
    ("Rizz Aura", ["rizz-aura"]),
    ("Oasis", ["oasis-app", "oasis-admin", "oasis-api", "oasis-files", "oasis-mail"]),
    ("ZapIt", ["zapit"]),
    ("PLUTUS", ["plutus"]),
    ("Atlas Chef", ["atlas-chef"]),
    ("AthenIQ LMS", ["atheniq-lms"]),
    ("Incus", ["incus"]),
    ("Mail", ["mail"]),
    ("Monit", ["monit"]),
    ("PM3", ["pm3"]),
    ("PM4", ["pm4"]),
    ("Jellyfin", ["jellyfin-ldap"]),
]


def load_env_file(path: Path) -> dict[str, str]:
    env: dict[str, str] = {}
    if not path.exists():
        return env
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, val = line.partition("=")
        env[key.strip()] = val.strip().strip('"').strip("'")
    return env


def api_call(method: str, path: str, base: str, token: str, body: dict | None = None) -> tuple[int, dict | list | None]:
    url = f"{base.rstrip('/')}{path}"
    data = json.dumps(body).encode() if body is not None else None
    headers = {"Accept": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    if data is not None:
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            raw = resp.read()
            return resp.status, (json.loads(raw) if raw else None)
    except urllib.error.HTTPError as e:
        detail = (e.read() or b"").decode(errors="replace")[:400]
        print(f"FAIL {method} {path} → HTTP {e.code}: {detail}", file=sys.stderr)
        return e.code, None


def find(results: list | None, **fields) -> dict | None:
    for item in results or []:
        if all(item.get(k) == v for k, v in fields.items()):
            return item
    return None


def ensure_stack_groups_api(base: str, token: str) -> bool:
    """Create one Authentik Group per stack and tie each app to its stack.

    Idempotent: existing groups are left alone, and an application already
    carrying the right ``group`` is not rewritten. Returns False if any write
    failed (so the caller can exit non-zero).
    """
    ok = True

    _st, data = api_call("GET", "/api/v3/core/groups/?page_size=500", base, token)
    existing = {g["name"] for g in ((data or {}).get("results") or [])} if isinstance(data, dict) else set()
    for stack, _slugs in STACKS:
        if stack in existing:
            print(f"PASS group '{stack}' already exists")
            continue
        st, _ = api_call("POST", "/api/v3/core/groups/", base, token, {"name": stack, "is_superuser": False})
        ok = ok and st < 400
        print(f"{'PASS created' if st < 400 else 'FAIL'} group '{stack}'")

    # superuser_full_list: the Application search endpoint filters results by the
    # calling user's own access, so without this flag a superuser token still
    # sees a single-row list and every stack lookup misses.
    apps = {a["slug"]: a for a in _list_all(base, token, "/api/v3/core/applications/",
                                            superuser_full_list="true")}
    for stack, slugs in STACKS:
        for slug in slugs:
            app = apps.get(slug)
            if app is None:
                print(f"WARN application '{slug}' (stack {stack}) not found — skipped")
                continue
            if app.get("group") == stack:
                print(f"PASS app '{slug}' already in '{stack}'")
                continue
            st, _ = api_call("PATCH", f"/api/v3/core/applications/{slug}/", base, token, {"group": stack})
            ok = ok and st < 400
            print(f"{'PASS' if st < 400 else 'FAIL'} app '{slug}' → '{stack}'")
    return ok


def _list_all(base: str, token: str, path: str, **extra: str) -> list[dict]:
    """GET every page of a list endpoint (Authentik caps page_size at 100).

    ``extra`` appends query parameters. The important one is
    ``superuser_full_list=true`` for /core/applications/: Authentik's search
    endpoints filter results down to the applications the *requesting token's
    user* can access, so even a superuser token sees only its own apps (count=24
    but results=1 at one point). Without the flag every stack lookup misses its
    applications and enforcement silently becomes a no-op.
    """
    out: list[dict] = []
    page = 1
    while True:
        sep = "&" if "?" in path else "?"
        qs = "&".join(f"{k}={v}" for k, v in extra.items())
        suffix = f"&{qs}" if qs else ""
        st, data = api_call("GET", f"{path}{sep}page_size=100&page={page}{suffix}", base, token)
        if not isinstance(data, dict):
            break
        out.extend(data.get("results") or [])
        if not data.get("pagination", {}).get("next"):
            break
        page += 1
    return out


def _stack_access_plan(base: str, token: str) -> tuple[dict[str, list[int]], list[dict], list[dict], list[dict]]:
    """Resolve (seed_users_by_stack, applications, groups, users).

    seed_users_by_stack maps a stack name to the user pks that must retain
    access, computed from: superusers + non-external (machine/internal)
    accounts + the stack's legacy admin group members + STACK_KEEP_ACCESS.
    """
    users = _list_all(base, token, "/api/v3/core/users/?include_groups=true")
    groups = _list_all(base, token, "/api/v3/core/groups/")
    apps = _list_all(base, token, "/api/v3/core/applications/", superuser_full_list="true")

    by_username = {u["username"]: u for u in users}
    members_by_group = {g["name"]: list(g.get("users") or []) for g in groups}

    always = {u["pk"] for u in users if u.get("is_superuser") or u.get("type") in KEEP_ACCESS_USER_TYPES}
    seeds: dict[str, list[int]] = {}
    for stack, _slugs in STACKS:
        keep = set(always)
        for legacy in STACK_LEGACY_GROUPS.get(stack, []):
            keep.update(members_by_group.get(legacy, []))
        for name in STACK_KEEP_ACCESS.get(stack, []):
            user = by_username.get(name)
            if user:
                keep.add(user["pk"])
            else:
                print(f"WARN keep-access user '{name}' ({stack}) not found — skipped")
        seeds[stack] = sorted(keep)
    return seeds, apps, groups, users


def enforce_stack_access_api(base: str, token: str, *, dry_run: bool = False) -> bool:
    """Bind each stack group to its applications so only members can reach them.

    An application with NO bindings is open to every authenticated user
    (Authentik's AppAccessWithoutBindings default), so enforcement adds one
    group PolicyBinding per application. Every stack group is seeded with the
    accounts that must keep access BEFORE the binding is created, then the
    result is verified with check_access: without that, seeding misses (and the
    engine's lack of a superuser bypass means) admins get locked out.

    Applications without a provider (plain tiles) are skipped — there is no
    login flow to gate.
    """
    ok = True
    seeds, apps, groups, users = _stack_access_plan(base, token)
    group_pk = {g["name"]: g["pk"] for g in groups}
    group_members = {g["name"]: list(g.get("users") or []) for g in groups}

    # 1. Seed memberships first — never bind before the keep-access users are in.
    for stack, keep in seeds.items():
        pk = group_pk.get(stack)
        if pk is None:
            print(f"FAIL stack group '{stack}' missing — run without --enforce-access first")
            ok = False
            continue
        current = sorted(set(group_members.get(stack, [])))
        merged = sorted(set(current) | set(keep))
        if merged == current:
            print(f"PASS '{stack}' members already seeded ({len(merged)})")
            continue
        if dry_run:
            print(f"PLAN '{stack}' members {current} → {merged}")
            continue
        st, _ = api_call("PATCH", f"/api/v3/core/groups/{pk}/", base, token, {"users": merged})
        ok = ok and st < 400
        print(f"{'PASS seeded' if st < 400 else 'FAIL seeding'} '{stack}' members "
              f"({len(current)} → {len(merged)})")

    # 2. One group binding per (provider-backed) application.
    bindings = _list_all(base, token, "/api/v3/policies/bindings/")
    have = {(b.get("target"), b.get("group")) for b in bindings}
    gated: list[dict] = []
    for stack, slugs in STACKS:
        pk = group_pk.get(stack)
        if pk is None:
            continue
        for app in apps:
            if app["slug"] not in slugs:
                continue
            if not app.get("provider"):
                print(f"SKIP '{app['slug']}' — no provider (tile only, nothing to gate)")
                continue
            gated.append(app)
            if (app["pk"], pk) in have:
                print(f"PASS binding '{app['slug']}' ↔ '{stack}' already present")
                continue
            if dry_run:
                print(f"PLAN bind '{app['slug']}' → group '{stack}'")
                continue
            st, _ = api_call("POST", "/api/v3/policies/bindings/", base, token,
                             {"target": app["pk"], "group": pk, "order": 0, "enabled": True})
            ok = ok and st < 400
            print(f"{'PASS bound' if st < 400 else 'FAIL binding'} '{app['slug']}' → '{stack}'")
    if dry_run:
        return ok

    # 3. Verify every seeded account still passes for every app it is seeded for.
    names = {u["pk"]: u["username"] for u in users}
    for app in gated:
        stack = next(s for s, slugs in STACKS if app["slug"] in slugs)
        for pk in seeds[stack]:
            st, data = api_call(
                "GET",
                f"/api/v3/core/applications/{app['slug']}/check_access/?for_user={pk}",
                base, token,
            )
            if not (isinstance(data, dict) and data.get("passing")):
                print(f"FAIL '{names.get(pk, pk)}' is seeded for {stack} but cannot reach "
                      f"'{app['slug']}' — enforcement would lock them out")
                ok = False
    print("PASS stack access verified" if ok else "FAIL stack access verification")
    return ok


def release_stack_access_api(base: str, token: str) -> bool:
    """Delete the group bindings enforcement created (leaves memberships alone)."""
    groups = {g["name"]: g["pk"] for g in _list_all(base, token, "/api/v3/core/groups/")}
    apps = {a["slug"]: a["pk"] for a in _list_all(base, token, "/api/v3/core/applications/", superuser_full_list="true")}
    stack_pks = {groups[s] for s, _ in STACKS if s in groups}
    app_pks = {apps[slug] for _s, slugs in STACKS for slug in slugs if slug in apps}
    removed = 0
    for b in _list_all(base, token, "/api/v3/policies/bindings/"):
        if b.get("target") in app_pks and b.get("group") in stack_pks:
            st, _ = api_call("DELETE", f"/api/v3/policies/bindings/{b['pk']}/", base, token)
            removed += st < 400
    print(f"PASS released {removed} stack access binding(s)")
    return True


def bootstrap_api(base: str, token: str, external_host: str, cookie_domain: str) -> int:
    """Provision via the REST API. Returns process exit code."""
    failed = False

    # 1+2. Proxy provider (the API exposes it at /providers/proxy/)
    st, data = api_call("GET", "/api/v3/providers/proxy/?name__iexact=" + PROVIDER_NAME.replace(" ", "%20"), base, token)
    prov = find((data or {}).get("results") if isinstance(data, dict) else None, name=PROVIDER_NAME)
    if prov is None:
        st, prov = api_call("POST", "/api/v3/providers/proxy/", base, token, {
            "name": PROVIDER_NAME,
            "mode": "forward_domain",
            "external_host": external_host,
            "cookie_domain": cookie_domain,
            "authorization_flow": "/api/v3/flows/instances/default-provider-authorization-implicit-consent/",
            "invalidation_flow": "/api/v3/flows/instances/default-invalidation-flow/",
            "skip_path_regex": r"^/outpost\.goauthentik\.io/",
            "internal_host_ssl_validation": False,
        })
        failed = failed or prov is None
        print("PASS created proxy provider" if prov else "FAIL proxy provider")
    else:
        print("PASS proxy provider already exists")

    if not prov:
        return 1
    prov_pk = prov["pk"] if isinstance(prov, dict) else prov

    # Application
    st, data = api_call("GET", f"/api/v3/core/applications/?slug={APP_SLUG}", base, token)
    app = find((data or {}).get("results") if isinstance(data, dict) else None, slug=APP_SLUG)
    if app is None:
        st, app = api_call("POST", "/api/v3/core/applications/", base, token, {
            "name": APP_SLUG,
            "slug": APP_SLUG,
            "provider": prov_pk,
        })
        failed = failed or app is None
        print("PASS created application" if app else "FAIL application")
    else:
        print("PASS application already exists")

    # 3. Embedded outpost: add the provider
    st, data = api_call("GET", "/api/v3/outposts/instances/", base, token)
    outpost = find((data or {}).get("results") if isinstance(data, dict) else None, name=OUTPOST_NAME)
    if outpost is None:
        print("FAIL embedded outpost not found", file=sys.stderr)
        return 1
    providers = list(outpost.get("providers") or [])
    if prov_pk not in providers:
        providers.append(prov_pk)
        st, _ = api_call("PATCH", f"/api/v3/outposts/instances/{outpost['pk']}/", base, token, {"providers": providers})
        failed = failed or st >= 400
        print("PASS provider added to embedded outpost" if st < 400 else "FAIL outpost update")
    else:
        print("PASS embedded outpost already serves the provider")

    # 4. Pin the embedded outpost's host to the provider's own vhost. The
    # embedded outpost ignores authentik_host_browser (goauthentik/authentik
    # #5922), so authentik_host is what the browser is redirected to; pointing
    # it at a different Authentik origin makes /application/o/authorize/
    # reject the redirect_uri ("Redirect URI Error").
    cfg = dict(outpost.get("config") or {})
    if cfg.get("authentik_host") != external_host or cfg.get("authentik_host_browser") != external_host:
        cfg["authentik_host"] = external_host
        cfg["authentik_host_browser"] = external_host
        st, _ = api_call("PATCH", f"/api/v3/outposts/instances/{outpost['pk']}/", base, token, {"config": cfg})
        failed = failed or st >= 400
        print(f"PASS embedded outpost host → {external_host}" if st < 400 else "FAIL outpost host")
    else:
        print(f"PASS embedded outpost host already {external_host}")

    # 5. Per-stack groups + application ties.
    failed = not ensure_stack_groups_api(base, token) or failed

    return 1 if failed else 0


SHELL_SCRIPT = f'''\
from authentik.providers.proxy.models import ProxyProvider, ProxyMode
from authentik.core.models import Application
from authentik.outposts.models import Outpost
from authentik.flows.models import Flow

auth_flow = Flow.objects.get(slug="default-provider-authorization-implicit-consent")
inv_flow = Flow.objects.get(slug="default-invalidation-flow")

prov, created = ProxyProvider.objects.get_or_create(
    name={PROVIDER_NAME!r},
    defaults={{
        "mode": ProxyMode.FORWARD_DOMAIN,
        "external_host": "{{external_host}}",
        "cookie_domain": "{{cookie_domain}}",
        "skip_path_regex": r"^/outpost\\.goauthentik\\.io/",
        "internal_host_ssl_validation": False,
    }},
)
if created:
    prov.authorization_flow = auth_flow
    prov.invalidation_flow = inv_flow
    prov.save()
print("PASS provider:", prov.name, "mode:", prov.mode, "created:", created)

app, app_created = Application.objects.get_or_create(
    slug={APP_SLUG!r},
    defaults={{"name": {APP_SLUG!r}, "provider": prov}},
)
if not app_created and app.provider_id != prov.id:
    app.provider = prov
    app.save()
print("PASS application:", app.slug, "created:", app_created)

outpost = Outpost.objects.get(name={OUTPOST_NAME!r})
if not outpost.providers.filter(pk=prov.pk).exists():
    outpost.providers.add(prov)
    outpost.save()
print("PASS outpost:", outpost.name, "providers:", list(outpost.providers.values_list("name", flat=True)))
'''


# Shell-mode continuation: outpost host + per-stack groups. Uses the same
# {external_host} placeholder convention as SHELL_SCRIPT.
SHELL_STACKS = '''\
_host = "{{external_host}}"
if outpost.config.get("authentik_host") != _host or outpost.config.get("authentik_host_browser") != _host:
    outpost.config["authentik_host"] = _host
    outpost.config["authentik_host_browser"] = _host
    outpost.save()
    print("PASS outpost host:", _host)
else:
    print("PASS outpost host already:", _host)

from authentik.core.models import Application, Group

for _name in {stack_names!r}:
    _g, _created = Group.objects.get_or_create(name=_name, defaults={{"is_superuser": False}})
    print("PASS group:", _name, "created:", _created)

for _stack, _slugs in {stack_map!r}.items():
    for _slug in _slugs:
        _app = Application.objects.filter(slug=_slug).first()
        if _app is None:
            print("WARN application missing:", _slug)
            continue
        if _app.group != _stack:
            _app.group = _stack
            _app.save()
            print("PASS app grouped:", _slug, "->", _stack)
        else:
            print("PASS app already in:", _slug, "->", _stack)
'''


def emit_shell(external_host: str, cookie_domain: str) -> int:
    code = SHELL_SCRIPT + SHELL_STACKS.format(
        stack_names=[name for name, _slugs in STACKS],
        stack_map={name: slugs for name, slugs in STACKS},
    )
    code = code.replace("{external_host}", external_host).replace("{cookie_domain}", cookie_domain)
    sys.stdout.write(code)
    return 0


def main() -> int:
    repo = REPO
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--env-file", default=str(repo / ".env"))
    parser.add_argument("--base-domain", default=None, help="override NPM_BASE_DOMAIN")
    parser.add_argument("--emit-shell", action="store_true",
                        help="print the ak-shell bootstrap code instead of calling the API")
    parser.add_argument("--shell", action="store_true", dest="shell",
                        help="read the shell script from stdin (companion to --emit-shell inside the container)")
    parser.add_argument("--enforce-access", action="store_true",
                        help="also bind each stack group to its applications so only members "
                             "can reach them (seeds superusers/internal accounts/operators first)")
    parser.add_argument("--release-access", action="store_true",
                        help="delete the stack access bindings this script created")
    parser.add_argument("--dry-run", action="store_true",
                        help="with --enforce-access, print the plan without writing")
    args = parser.parse_args()
    env = load_env_file(Path(args.env_file))

    base_domain = (args.base_domain or os.environ.get("NPM_BASE_DOMAIN") or env.get("NPM_BASE_DOMAIN") or "capstone.innotel.us")
    external_host = f"https://auth.{base_domain}"
    cookie_domain = base_domain

    if args.emit_shell:
        return emit_shell(external_host, cookie_domain)

    base = (os.environ.get("AUTHENTIK_PUBLIC_URL") or env.get("AUTHENTIK_PUBLIC_URL") or f"https://auth.{base_domain}").rstrip("/")
    token = os.environ.get("AUTHENTIK_TOKEN") or env.get("AUTHENTIK_TOKEN") or ""
    if not token:
        print("FAIL no AUTHENTIK_TOKEN — mint one in Authentik (Directory → Tokens) "
              "or use --emit-shell inside the container", file=sys.stderr)
        return 1
    rc = bootstrap_api(base, token, external_host, cookie_domain)
    if args.release_access or args.enforce_access:
        # Groups must exist first — bootstrap_api above guarantees that.
        ok = (release_stack_access_api(base, token) if args.release_access
              else enforce_stack_access_api(base, token, dry_run=args.dry_run))
        rc = rc or (0 if ok else 1)
    return rc


if __name__ == "__main__":
    sys.exit(main())
