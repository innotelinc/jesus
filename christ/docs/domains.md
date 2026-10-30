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

The zones are hosted on **Cerulean**: Technitium answers authoritatively for all
seven, the registrar delegates each name to `ns1.<zone>`/`ns2.<zone>`, and glue
points at the home connection's address. That delegation is *in-bailiwick*, so
Cerulean is the only thing that can answer for these names — there is no second
path if it is down, and while it is down all seven names are `SERVFAIL` at every
public resolver, whatever the zones contain.

Two conditions keep it answering, and both have to hold:

1. Technitium is running on the `cerulean` host (console on `:5380`, API on
   `/api/`), holding a primary zone for each of the seven names.
2. The router forwards UDP **and** TCP 53 to that host, because the glue names a
   public address and the registry does not know anything about the LAN.

`deploy/publish-dns.py` is the one way to write the records, and it is idempotent
— it reads each zone, changes only what disagrees, and prints the value it
replaced so the edit can be put back by hand:

```sh
VAULT_TOKEN_FILE=... ./deploy/publish-dns.py --show
VAULT_TOKEN_FILE=... ./deploy/publish-dns.py --apply --ip <edge ip>
./deploy/publish-dns.py --verify --ip <edge ip>      # no credential needed
```

The credential comes from Vault (`cerulean/technitium`: `url`, `user`,
`password`) or from `TECHNITIUM_URL`/`TECHNITIUM_USER`/`TECHNITIUM_ADMIN_PASSWORD`
when Vault is not reachable. On `cerulean` the working value is
`TECHNITIUM_ADMIN_PASSWORD` in `/usr/src/projects/complete/1-primary/cerulean/.env`:
the same name inside the running container is the value compose wrote at creation,
so it goes stale the first time the admin password is rotated and reports
`Invalid username or password` while the zone file is perfectly fine. `--show`
names where the password came from, so that failure is one line to tell apart. `--verify` never logs in: it asks `1.1.1.1` and
`8.8.8.8` over DNS-over-HTTPS and then pins a TLS handshake at the edge, so it
works from a laptop with no `dig` and keeps working while the authoritative host
is down — which is exactly when the answer matters.

Each zone needs **two** records, not one: the apex `A` and `www` as a `CNAME` of
the apex. `--apply` writes both.

`www.` has to exist. Each edge site block answers for `<zone>` **and**
`www.<zone>`, and Caddy requests one certificate covering both names, so a
`www` that resolves nowhere fails the certificate for the apex too — the edge
logs it as a challenge against the *old* address and retries with backoff. If the
box has an IPv6 address, add the `AAAA` records as well: a name with only `A`
records still works, but a client that prefers IPv6 spends a round trip finding
that out.

A standby copy of the same records exists in **Vultr DNS**
(`ns1.vultr.com`/`ns2.vultr.com`), written by `deploy/publish-vultr-dns.py`. It
is not in the live path: the names resolve because Cerulean answers, and nothing
asks Vultr while the delegation says `ns1.<zone>`. It exists so that a day the
host cannot be brought back has a one-command answer that needs no router
forward — moving the delegation then makes it live.

`CAA` is `issue "letsencrypt.org"` in all seven, which is exactly the CA the edge
uses, so certificate issuance succeeds on the first request after the record
moves. Certificates are not tied to who answers DNS: the edge already holds a
valid Let's Encrypt certificate for every one of the seven names (through 28 Jan
2027), issued while the old records still answered, so a corrected record makes
them live rather than re-issuing them.

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

These are zone records, so they go into the `telno.services` zone on Cerulean —
delegation is what lives at the registrar, and it does not change.
`publish-dns.py` writes only the apex `A` and the `www` alias; the text records
are added once in the Technitium console (or through `/api/zones/records/add`).
The zone already carries
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
