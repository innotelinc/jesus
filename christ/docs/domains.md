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
telno.services      A   <edge ip>
telno.online        A   <edge ip>
telno.mobi          A   <edge ip>
telno.digital       A   <edge ip>
telno.tel           A   <edge ip>
telno.directory     A   <edge ip>
telno.network       A   <edge ip>
```

`www.` for each of them is served by the same blocks (Caddy answers for both and
the app does not care which arrived). If the box has an IPv6 address, add the
`AAAA` records too — a name with only `A` records still works, but a client that
prefers IPv6 will spend a round trip discovering that.

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

At the registrar, for `telno.services`:

```
telno.services.        TXT  "v=spf1 include:_spf.resend.com -all"      # or include:spf.mailjet.com
_dmarc.telno.services. TXT  "v=DMARC1; p=quarantine; rua=mailto:dmarc@telno.services; adkim=r; aspf=r"
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
