# The estate

One switch, the products that sit on it, and one console that shows the whole
thing. This directory is the demo: `./up.sh` and there is a working telephone
system on the box, with no SIP registrar, no RTP range, no AMI socket and no
FreePBX database to keep alive.

```
    browser ──HTTPS/WSS──► console (this repo) ──HTTP──► Cantus switch ──UDP──► Cantus switch
                              │                            ▲   │
                              └─────── telno (platform) ───┘   └── ARI ──► dograh / capstone
```

## What runs

| service | what it is | where |
| --- | --- | --- |
| `switch` | Cantus 1.0 node: signalling + media on 7443/udp, relay on 7444/udp, control API + ARI surface + browser softphone on 8088 | `apps/cantus-switch` |
| `telno` | the platform: accounts, numbers, directory, routing document, recordings | `apps/telno` |
| `console` | the estate console: live calls, routing document, lines, call tape, product pills | `estate/console` |

Capstone (dograh, interviews, dashboards) is a separate and much larger stack.
It joins this switch rather than running its own — see "Adding Capstone" below.

## Run it

```sh
cd estate
./up.sh            # generates .env, builds, starts, waits for the switch
./up.sh logs       # follow
./up.sh down       # stop, keep data
./up.sh reset      # stop and delete volumes (telno database, recordings)
```

Then open:

- **console** — <http://localhost:8000>
- **switch** — <http://localhost:8188/v1/status>
- **ARI** — <http://localhost:8188/ari/asterisk/info> (user `dograh`, password from `.env`)
- **telno** — <http://localhost:8090> (owner login is `ADMIN_EMAIL`; a generated password is printed once in `docker compose logs telno`)

The switch's `8088` is mapped to `8188` on the host. The internal port is fixed
because the ARI endpoint dograh dials is written into its telephony
configuration; the host port is free to move.

### What to try

1. Dial `101@estate.local` from the console. Line 101 has no softphone attached,
   so the call rings out and lands on the tape as `no-answer` — the routing
   document was still consulted, and the console shows the route it picked.
2. Open `101` in a browser softphone (telno, or
   `http://localhost:8188/ws/line?ext=101` directly) and dial again: the call
   answers and the media counters in the switch status start moving.
3. Dial `8000@estate.local`. That route hands the call to ARI app `dograh`; with
   no ARI client connected the switch rejects it instead of hanging.
4. Edit `switch/routes.json`, `./up.sh down && ./up.sh up`, and watch the
   routing document move in the console. telno overwrites it on its next
   provisioning run, which is the point — the database is the source of truth,
   the switch is the thing that executes it.

## Adding Capstone

Capstone already ships this switch as its `cantus-switch` service, gated behind
the `standalone` profile, and answers on `8088` for ARI. To make one switch own
the whole estate instead of two:

```sh
# 1. keep this switch's identity
grep -E 'CANTUS_(SECRET|CONTROL_TOKEN|ARI_)' estate/.env

# 2. tell the Capstone checkout to use it
cd apps/capstone
cat >> .env <<'EOF'
CAPSTONE_PBX=external
CANTUS_SECRET=…same as estate…
CANTUS_CONTROL_TOKEN=…same as estate…
CANTUS_ARI_USER=dograh
CANTUS_ARI_PASSWORD=…same as estate…
DOGRAH_ARI_HOST=host.docker.internal
DOGRAH_ARI_PORT=8188
EOF

# 3. bring Capstone up WITHOUT its own switch
docker compose --profile "" up -d      # no `standalone` profile

# 4. light up its pill in the estate console
echo 'CAPSTONE_URL=http://host.docker.internal:8089' >> ../../estate/.env
```

`apps/capstone/pbx/` holds the switch-side half of that integration:
`routes.json` (DIDs → the `dograh` ARI app, agent extensions → bridge, office
hours → fallback), `lines.json`, `bootstrap_cantus.py` (idempotent apply through
the control API) and `sync_agent_numbers.py` (agent roster → switch lines).
Neither script talks to a database the switch owns, and neither needs a
container exec.

## Why there is no Asterisk here

The old stack was FreePBX on Asterisk 22: SIP on 5060, WSS on 8089, AMI on 5038,
RTP on 10101-10120, MariaDB for the dialplan, Webmin on 10000, and a browser
softphone that had to trust a self-signed certificate. Cantus replaces the lot
with one signed UDP transport and one HTTP port, which is why the console can be
a static page and the demo can fit on the smallest Vultr instance. The
ARI-compatible surface exists only so dograh did not have to change.

## Vultr

`tools/vultr-demo.sh` creates a throwaway instance, boots this estate through
cloud-init and prints the URLs. See `tools/README.md`.
