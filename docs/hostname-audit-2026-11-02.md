# Estate hostname audit — 2026-11-02

Every A/CNAME record in the 27 authoritative zones that points at an estate address was probed over HTTPS (414 distinct names). Grouped by the address it reaches.

Two corrections to the first pass of this document are recorded below, because both change what the estate's problem actually is: the initial run called names "no TLS" that were in fact never reached, and it counted failures that a re-probe fifteen minutes later showed answering.

## 45.77.221.158 — the consolidated edge: 22 names

| result | count | meaning |
|---|---|---|
| ok | 21 | answers with a page, certificate valid for the name |
| auth | 1 | answers, asks for a sign-in (correct) |

Four of these arrived during this audit, moved off `73.68.203.71` and verified after the move:

| name | answers | certificate |
|---|---|---|
| `christ.innotel.us` | 200, the CHRIST board | issued 05:56Z, expires 2027-01-31 |
| `directory.pbx.services` | 302 → `/d/directory.pbx.services` → 200 | issued 05:56Z, expires 2027-01-31 |
| `directory.pbx.technology` | 302 → `/d/directory.pbx.technology` → 200 | issued 05:56Z, expires 2027-01-31 |
| `directory.telno.services` | 302 → `/d/directory.telno.services` → 200 | issued 05:56Z, expires 2027-01-31 |

The three phonebook names were 502s on the old box: the registry has always carried them (`DIRECTORY_HOSTS` in `apps/telno/src/config.js`), so the names were pointed at the box that owns the work rather than the box that used to forward it. They are declared in `christ/domains.json` and rendered from there.

## 73.68.203.71 — the old edge: 272 names still reach it

The 276-name suspect set from the first pass was re-probed twice each, sequentially enough not to trip the box's own rate limits. The result is not a certificate problem:

| result | count | what it actually is |
|---|---|---|
| handshake rejected | 206 | `tlsv1 unrecognized name` — nginx refuses the name at the handshake, i.e. **no vhost for it**, no certificate asked for |
| 302 | 22 | answering, redirecting somewhere |
| 200 | 20 | answering |
| 301 | 11 | answering, redirecting |
| 404 | 4 | vhost exists, route does not |
| 502 | 1 | vhost and certificate fine, upstream behind it is gone |
| 307 / 308 / 401 / 501 | 5 | answering, by design |
| wildcards | 3 | `*.genie`, `*.lab`, `*.atheniq` — reported, not names a browser types |

Handshake rejections by zone: `innotel.us` 141, then three each in `rizzaura.net`(5), `loomix.art`, `loomix.lol`, `atheniq.courses`, `atheniq.institute`, `atheniq.online`, `innotel.site`, `innovative.tel`, `ontrak.technology`, `it.com`, `pbx.services`, `pbx.technology`, `telno.services`.

**The certificates on that box are not the fault.** The names it does serve carry valid Let's Encrypt certificates — `rizzaura.net` has `*.rizzaura.net` + apex, `atheniq.online` has `*.atheniq.online` + apex, `christ.innotel.us` had its own — all with months left. A name that fails there was never added to its proxy, and adding one needs a shell on that box, which this host cannot reach (port 22 closed from the estate's vantage point; 80 and 443 are the only open ports).

## Still failing, and why

| name | result | cause |
|---|---|---|
| `blueprint.innotel.us` | 502 | vhost up, upstream process gone |
| `admin.onyx.innotel.us`, `api.onyx.innotel.us`, `backup.onyx.innotel.us` | 404 | Go-style "404 page not found": the old proxy aliases point at a route that was removed |
| `api.rizzaura.net` | 404 | `{"ok":false,"error":"not found"}` — the app answers, the endpoint does not exist |
| `app.onyx.innotel.us` | 401 | route exists, credential required |
| `admin.oasis.innotel.us` | 501 | route exists, handler unimplemented |
| `pi.innotel.us` | 403 | Pi-hole admin, refusing by design |
| `app.loomix.art`, `app.loomix.lol` | connect failure | resolves to `73.68.203.71`, nothing answers on 443 for those names |
| `i3.innotel.us`, `pm4.innotel.us` | 502 in the first pass, handshake-rejected now | proxy-manager instances on retired hardware |

None of these can be repaired from here: their upstreams are processes on boxes without a shell from this host. What the consolidated edge *can* serve, it now serves.

## What did not move, and why

`rizzaura.net` (apex, `www`, `app`, `api`, `auth`, `admin`, `mail`, `community`, `com.unity`) and `atheniq.online` / `atheniq.courses` / `atheniq.institute` (plus `class`, `mail`, `ns1`) all answer on `73.68.203.71` today. The applications behind them — the Rizzaura site and API, the Atheniq course platform and its Grafana — exist nowhere in this stack: the edge has no container, image or volume that serves them, so an A record moved to `45.77.221.158` today would not consolidate anything, it would take down a working site and answer 404 from the front door. They move when their applications move, one line of `domains.json` and one record each.

That is the same reason `docs/dns-retired-66.42.116.17.json` exists: a name follows its application, not the other way round.

## What the proxy box actually looks like, and what was repaired on it

`73.68.203.71` is the WAN address of the home LAN; the box behind it is `proxy` at `192.168.1.71`, and it runs the estate's existing edge (`cerulean-npm`, an OpenResty build of Nginx Proxy Manager) with **204 proxy hosts and 24 redirections**, 229 enabled vhosts in all. Every name that answers on that address answers because of one of those hosts. The names that refuse the handshake simply have none — they were vhosted on the retired `66.42.116.17` and only their DNS was carried over.

Where the applications behind those vhosts live:

| application | served by | names |
|---|---|---|
| **Atheniq** | `104.238.162.5` — institute `:8085`, courses/apps/studio/catalog/learn `:18080`, workforce `:8087` | `atheniq.institute`, `atheniq.courses`, `atheniq.online`, subdomains |
| Zeus | `104.238.162.5:8088` | `zeus.innotel.us` |
| Rizzaura | `192.168.1.62` — site/app `:3021`, api `:3020`, admin `:3013`, rankings `:3022` | `rizzaura.net`, `app.`, `api.`, `admin.`, `rankings.` |
| Onyx | `192.168.1.60` — app `:2080`, api `:2081`, storage `:2090`, backup `:2084` | `onyx.innotel.us`, `app.`, `api.`, `storage.`, `backup.` |
| Oasis / mail | `192.168.1.15` — `:3000`, admin `:8091`, mail `:8080` | `oasis.innotel.us`, `files.`, `mail.` |
| Loomix | `192.168.1.15:3000` | `loomix.art`, `loomix.lol` |
| Atlas (Gitea), Genie | `192.168.1.90:3004`, `192.168.1.21:3400` | `atlas.innotel.us`, `genie.innotel.us` |

Repaired on that box and in DNS:

| name | was | change |
|---|---|---|
| `admin.onyx.innotel.us` | 404 — pointed at the API (`:2081`), which has no route for a panel | forwarded to the app (`:2080`); **now 200** |
| `blueprint.innotel.us` | 502 — upstream `192.168.1.52:8787` gone | host disabled, record retired |
| `pm4.innotel.us` | refused — upstream `192.168.1.4:8006` gone, no vhost | record retired |
| `i3.innotel.us` | refused, no vhost | record retired |
| `app.loomix.art`, `app.loomix.lol` | refused, no vhost | record retired (the Loomix app answers on the apex) |
| `accounts.`, `acme.`, `astpp.`, `ansible.`, `auth1.innotel.us` | refused, no vhost, no application | records retired |

Retired records are in `docs/dns-retired-2026-11-02.json` — type, rdata and zone per name — so any of them can be republished.

Deliberately left alone: `app.onyx.innotel.us` answers 401 because oauth2-proxy in front of it is asking for a credential (correct, not broken); `pi.innotel.us` answers 403 because Pi-hole refuses the admin UI from outside (correct); `api.rizzaura.net` answers `{"ok":false,"error":"not found"}` at `/` because the API has no route there — the service is alive and the path is the caller's; `admin.oasis.innotel.us` answers 501 from the application at `:8091`, which is an upstream answer, not a proxy one.

What is left are the ~190 names of the retired box's family (`*.capstone.*`, `*.rizz.*`, `*.zeus.*`, `*.atlas.*`, `ns1/ns2`, `mail.*`). The `ns1`/`ns2` names are delegation records and need no vhost; the `mail.*`/`autoconfig`/`mta-sts` names exist for MX and autodiscovery. The rest need either their application added to a host on this box (which means a certificate re-issue per host, since a new name in a block is a new name on the certificate) or retirement — a decision per family, not a sweep.

## 2026-11-02, second pass: names served, names retired

Two rules, applied name by name against what the proxy box actually hosts.

**Served.** A name whose parent is a live host on the proxy box joins that host, and the host gets a fresh certificate covering every name in the block. Ten names came back this way: the whole `zeus.innotel.us` family (`admin`, `app`, `api`, `auth`, `ws`, `portal`, `teams`, `pbx` — all now 200 behind one certificate), `api.atlas.innotel.us` (200, Gitea) and `dns.proxy.innotel.us` (302). `admin.onyx.innotel.us` had already been moved off the API port to the app.

**Retired.** A name with no host and no live parent is a name nobody can resolve to anything, so its record is gone rather than left refusing the handshake: twelve `*.capstone.innotel.us`, six `*.rizz.innotel.us` (the parent `rizz.innotel.us` does not exist anywhere on the box), and the ten leftovers retired earlier. Twenty-eight names in total; every record is in `dns-retired-2026-11-02.json`.

**Not done, and why.** The three redirection hosts (`atheniq.innotel.us`, `learn.innotel.us`, `ontrak.innotel.us`) refuse a write through this fork's API — `data must NOT have additional properties` for every field set that omits only the read-only ones — so `auth.atheniq.innotel.us`, `apps.learn.innotel.us` and the `*.ontrak.innotel.us` names still refuse the handshake. They need the write done in the NPM UI, or the fork's schema read first. Also unplanned: the proxy box rebooted at 02:26Z and came back with its containers up; the public names were verified answering afterwards.
