# The estate's domains

Seven domains, seven jobs, one file. `christ/domains.json` declares every host
and what it is for; `node cli.js edge --write` renders it into
`christ/deploy/Caddyfile`, and `christ/test/domains.test.js` fails the build when
the two disagree. The proxy container (`edge`, in the `core` profile) is the only
process that terminates TLS.

| Domain | Job | Serves |
| --- | --- | --- |
| `telno.services` | the product, the price, the signup — and the sending domain for all mail | telno app, the public site |
| `telno.online` | self-serve: a plan, a card, an extension | telno app, the public site (signup door) |
| `telno.mobi` | the phone in a pocket | telno app, the public site (softphone door) |
| `telno.digital` | numbers as records: registry and lookup | telno app, the public site (numbers door) |
| `telno.tel` | handsets, sign-in, `/<vendor>/<mac>.cfg` provisioning, the SIP domain | telno app |
| `telno.directory` | the worldwide phonebook itself | telno app, `/d/telno.directory` |
| `telno.network` | the estate, layer by layer | CHRIST board (`christ:8001`) |

Every domain serves the same application; `apps/telno/web/src/sites.js` is what
decides which hero, which headline and which call to action a visitor gets. A
host that is not in that file falls back to the brand's own copy, which is what a
local port and a preview URL get. `?site=telno.mobi` previews a door without
owning its DNS.

## DNS

All seven names point at the same box, and the proxy issues a certificate for
each. Nothing else in the estate needs a public name.

```
telno.services      A   <edge ip>      www CNAME -> apex
telno.online        A   <edge ip>      www CNAME -> apex
telno.mobi          A   <edge ip>      www CNAME -> apex
telno.digital       A   <edge ip>      www CNAME -> apex
telno.tel           A   <edge ip>      www CNAME -> apex
telno.directory     A   <edge ip>      www CNAME -> apex
telno.network       A   <edge ip>      www CNAME -> apex
```

The zones are hosted in **Vultr DNS** (`ns1.vultr.com`, `ns2.vultr.com`). They were
self-hosted before: the registry delegated each name to `ns1.<zone>`/`ns2.<zone>`
with glue pointing at a home connection, and Technitium on the `cerulean` host
answered. An in-bailiwick delegation has no second path — when that host stopped
answering, all seven names went `SERVFAIL` at once and stayed there, because the
only thing that could answer for them was the thing that was down. Out-of-bailiwick
nameservers need no glue and cannot be orphaned by a home IP change, which is why
the zones live at Vultr now.

`deploy/publish-vultr-dns.py` is the one way to write them, and it is idempotent —
it reads each zone, changes only what disagrees with this file, and says what it
touched:

```sh
VULTR_API_KEY=... ./deploy/publish-vultr-dns.py --show
VULTR_API_KEY=... ./deploy/publish-vultr-dns.py --apply --ip <edge ip>
./deploy/publish-vultr-dns.py --verify --ip <edge ip>   # asks ns1.vultr.com
```

It sets the apex `A`, `www` as a CNAME of the apex, `CAA issue "letsencrypt.org"`
(the only CA the edge uses), and on `telno.services` the SPF and DMARC records. It
also removes the catch-all `CNAME *` that a fresh Vultr zone arrives with: a name
that answers for every host is the opposite of a declared map.

**The registrar is the one step no script here can do.** The seven names are
registered at Namecheap, and delegation is that account's to change: set each
zone's nameservers to `ns1.vultr.com` and `ns2.vultr.com` and the zones below are
what the world then sees. Until that happens the zones answer authoritatively but
no resolver asks them, so the names do not resolve publicly however correct the
zone is. `deploy/publish-dns.py` still exists and still works against Cerulean's
Technitium, for the day that host is the authority again for some other zone.

`www.` has to exist. Each edge site block answers for `<zone>` **and**
`www.<zone>`, and Caddy requests one certificate covering both names, so a
`www` that resolves nowhere fails the certificate for the apex too — the edge
logs it as a challenge against the *old* address and retries with backoff. If the
box has an IPv6 address, add the `AAAA` records as well: a name with only `A`
records still works, but a client that prefers IPv6 spends a round trip finding
that out.

`CAA` is `issue "letsencrypt.org"` in all seven, which is exactly the CA the edge
uses, so certificate issuance succeeds on the first request after the record
moves. Certificates are not tied to who answers DNS: the edge already holds a
valid Let's Encrypt certificate for every one of the seven names, issued while the
old delegation still answered, so moving the delegation makes them live rather
than re-issuing them.

Moving the record is the whole change: the edge already carries a block for each
name and its `www.`, so issuing the certificate is simply what happens next. An
edge that has already failed while the old address was live is sitting in ACME
backoff, though, so `docker restart edge` is what makes the next attempt happen
now rather than in an hour — a nudge, not a requirement.

Ports 80 and 443 have to reach the box for Let's Encrypt to complete the
`http-01` challenge; `EDGE_HTTP_PORT`/`EDGE_HTTPS_PORT` exist so a box behind a
NAT can publish them somewhere else. There is no TLS switch in the Caddyfile: a
host in the map gets a certificate or it does not answer.

## Mail

`telno.services` is the sending domain: `NOTIFY_FROM` defaults to
`no-reply@telno.services` and `replyTo` to `support@telno.services`, so every
verification code, invoice, reminder and campaign report leaves from one domain
with one reputation.

Delivery needs a provider key in the vault (Settings → Vault): `RESEND_API_KEY`
or the Mailjet pair. The console reports which provider is live and refuses to
claim a message was delivered when none is configured — it writes the message to
the log instead.

These are zone records, so they go into the `telno.services` zone with
`publish-vultr-dns.py` rather than to the registrar — delegation is what lives at
the registrar, and it does not change. The zone already carries
`v=spf1 mx include:spf.mailjet.com ip4:<old edge ip> ~all`; the `ip4` has to
follow the box if anything ever sends straight from it, and the provider's
`include:` is what covers the usual path:

```
telno.services.                    TXT  "v=spf1 mx include:spf.mailjet.com ip4:<edge ip> ~all"
_dmarc.telno.services.             TXT  "v=DMARC1; p=quarantine; rua=mailto:dmarc@telno.services; adkim=r; aspf=r"
resend._domainkey.telno.services.  TXT  <the DKIM key the provider gives you>
```

DKIM is per provider and per domain: copy the selector record from Resend's or
Mailjet's domain screen rather than inventing one. Until it is in place, mail
still *sends* — it just lands in spam, which is why the console shows the
provider and the From address it is actually using.

One thing follows the DNS rather than leading it: the platform's own
`PUBLIC_URL`. It stays `http://<box ip>:8090` until the names resolve here,
because the softphone links and invoice links it generates would otherwise point
at whatever server currently holds the record. Set
`PUBLIC_URL=https://telno.services` in the env once the A records are live.

## Checking it

```sh
./deploy/domains.sh                        # names → whatever DNS says, certificates verified
./deploy/domains.sh --ip 45.77.221.158     # that box directly, SNI intact
```

A row that answers `200` with a Let's Encrypt certificate is a name that is
finished. The pinned form is what to run while records are still moving: it keeps
the SNI and the `Host` header, so the edge either serves the name or says why —
`ERR_SSL_TLSV1_ALERT_INTERNAL_ERROR` means it holds no certificate for it, which
happens for exactly one reason. Let's Encrypt answers an `http-01` challenge by
asking the address the record names, so as long as the record points at the old
server, the new one can never be signed into.

## Testing without DNS

A box whose records still point elsewhere cannot get a certificate, so its front
door answers `308` to `https://` and nothing more. The routing itself is still
testable: `node cli.js edge --http` renders the same map with TLS off, and a
throwaway Caddy on the compose network serves it:

```sh
docker run --rm -v /opt/christ/jesus:/jesus -w /jesus/christ node:22-alpine \
  node cli.js edge --http > /tmp/Caddyfile.http
docker run -d --name edge-probe --network christ_default -p 127.0.0.1:8099:80 \
  -v /tmp/Caddyfile.http:/etc/caddy/Caddyfile:ro caddy:2-alpine

for h in telno.services telno.online telno.mobi telno.digital telno.tel \
         telno.directory telno.network; do
  printf '%-16s ' "$h"
  curl -s -o /dev/null -w '%{http_code} %{redirect_url}\n' -H "Host: $h" http://127.0.0.1:8099/
done
docker rm -f edge-probe
```

Five hosts answer `200` from the platform, `telno.directory` answers `302` to
`/d/telno.directory`, and `telno.network` answers `200` from the CHRIST board —
which is the whole routing decision, one line each.
