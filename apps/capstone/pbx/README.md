# The voice plane

The switch is **Cantus 1.0** ([`apps/cantus`](../../cantus)) running as
[`cantus-switch`](../../cantus-switch). It is the `cantus-switch` service in
`docker-compose.yml`. This directory is everything about it that is specific to
capstone: the routing document, the line inventory, and two small tools that
keep them in step with everything else.

## What used to be here, and why it is not

| removed | what it did | what replaced it |
|---|---|---|
| `asterisk/ari.conf` | an ARI user and password in a file | `CANTUS_ARI_USER`/`CANTUS_ARI_PASSWORD` on the service; Basic auth on `/ari` |
| `asterisk/extensions_custom.conf` | the dialplan, hand-written, per context | `cantus/routes.json`, validated at load |
| `asterisk/rtp_custom.conf`, `rtp_settings_guard.py` | RTP ranges, and a guard that re-wrote rows FreePBX kept lower-casing | no RTP range to declare; one UDP socket per node |
| `asterisk/http.conf`, `websocket_client.conf` | the PJSIP WSS listener on 8089 | the softphone socket on 8088, same origin as the console |
| `asterisk_converge.py` | merged per-context dialplan files at boot | `bootstrap_cantus.py`, one document, idempotent |
| `entrypoint-dograh.sh` | 185 lines of boot-time surgery on a FreePBX image | the container's own env, plus the two tools below |
| `fail2ban/` | blocked SIP registrations that guessed passwords | nothing to ban: there is no registration port on the internet |
| `bootstrap_dograh_route.py`, `scripts/sync_dograh_routes.py` | wrote FreePBX MySQL rows with `docker exec` | `sync_agent_numbers.py`, a merge into the document |
| the `pbx-sso` gateway | SSO in front of FreePBX's GUI | there is no GUI; the console is `dashboard` |

FreePBX and AvantFax went with Asterisk: both are administration surfaces for a
PBX that is no longer there, and a GUI that rewrites configuration is exactly
the second source of truth this switch removes.

## The three things you can do here

```bash
# Load the document and the inventory into a running switch. Idempotent.
python3 pbx/bootstrap_cantus.py --url http://localhost:8088

# Make every number dograh advertises dialable, preserving hand-written routes.
python3 pbx/sync_agent_numbers.py --dry-run

# Score the document without a switch — the same evaluation the switch does.
node ../cantus-switch/src/cli.js route-test pbx/cantus/routes.json --to 8001@capstone.local
```

`pytest pbx/tests` proves the document's shape, that a second bootstrap changes
nothing, and that the number sync creates, keeps and removes the routes it owns.

## How a call reaches an agent

```
DID 8001 ──▶ cantus-switch ──▶ routes.json ──▶ { answer } { ari: dograh }
                                                     │
                                     StasisStart ────▶ dograh (dograh's ARI WS)
                                                     │
                            externalMedia + bridge ──▶ audio both ways
```

The `ari` action is terminal: it hands the channel to the application, which
then answers, plays, records and bridges through `/ari`. dograh is unchanged —
same ARI dialect, same telephony configuration, same scripts — it just dials
`http://<host>:8088` instead of a FreePBX box, which is what
`ansible/dograh-ari.yml` now writes.

An application that is not connected is refused rather than left to fail on the
first call: `bootstrap_cantus.py` exits 1 and names it.

## Ports

| | before | now |
|---|---|---|
| SIP / SIP-TLS | 5060/udp, 5061/tcp | — |
| ARI / HTTP / WSS | 8088, 8089 | 8088 (control, ARI, softphone) |
| AMI | 5038 | — (the control API) |
| RTP | 10101–10120/udp | — |
| Webmin | 10000 | — |
| Cantus + relay | — | 7443/udp, 7444/udp |

Two UDP ports for the whole switch. A firewall rule, not a range — and no
inbound SIP port, which is why the fail2ban jail has nothing left to watch.

## What is still Asterisk-shaped, stated plainly

- `dashboard-backend/app/agents.py` and `main.py` still provision extensions by
  running `fwconsole` and MySQL inside a PBX container. On this switch the same
  work is `POST /v1/lines` and a merge into `routes.json`; until that is ported,
  `CAPSTONE_DEPLOY_MODE` defaults to `addon` (dashboard manages dograh only) and
  the Control Center's PBX panel reports the switch as externally managed.
- `docs/operations.md`, `docs/zeus-integration.md`, `docs/networking.md` and
  `CHANGELOG.md` describe the FreePBX topology. The changelog is history and
  stays; the other three are being rewritten, and where they disagree with this
  file this file is right.
- `PJSIP_MEDIA_ADDRESS` is still the name of the host's LAN address in `.env`,
  because a dozen scripts read it. It is an address, not a SIP setting.
