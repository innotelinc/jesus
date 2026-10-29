# Deploying the demo

Two files:

- `cloud-init.sh` — prepares the instance: Docker from Docker's own repository,
  `/opt/cantus-estate`, and a ready marker. It does **not** clone anything.
- `vultr-demo.sh` — the operator's side. Creates a firewall group, an SSH key and
  an instance through the Vultr API v2, uploads this tree, runs `estate/up.sh`
  over SSH, waits for the console, and can destroy all of it again.

The instance runs the tree that was verified on your machine, packed by
`./vultr-demo.sh pack`: `estate/`, `apps/cantus-switch/` and `apps/telno/`
without `node_modules`, build output, local data or `.env`. A branch that was
never pushed cannot replace what you tested.

## Requirements

`bash`, `curl`, `tar`, `ssh`/`scp`, `ssh-keygen`, `base64`, `node` — and a Vultr
API key:

```sh
export VULTR_API_KEY=...        # Vultr → Account → API → Personal Access Token
```

or, so a deploy is one command without exporting a secret into your shell
history or this chat:

```sh
cd estate/tools
printf 'VULTR_API_KEY=%s\n' 'your-token' > .vultr-key.env
chmod 600 .vultr-key.env
```

Both files are git-ignored. The key is only ever read by the script.

## Up

```sh
cd estate/tools
./vultr-demo.sh up
```

It prints:

```
  console    http://203.0.113.9:8000
  switch     http://203.0.113.9:8188/v1/status
  telno      http://203.0.113.9:8090
  ARI        http://203.0.113.9:8188/ari/asterisk/info
```

Timing on `vc2-2c-2gb`: instance boot ~40 s, cloud-init (Docker) ~60 s, then two
image builds on the box — the telno image compiles its web bundle — for roughly
three to five minutes before the console answers. `./vultr-demo.sh logs` tails
the boot log; the command itself polls `http://<ip>:8000/healthz` until it is up
or ten minutes have passed.

### Why not 1 GB

`vc2-1c-1gb` is not enough, measured rather than guessed. Building both images
on it does not fail cleanly: the box stops answering on every port while the
API still reports `active / running / ok`, and only a reboot brings it back —
twice in a row, with 2.4 GB of swap already in place. Vultr also rolled back an
in-place `vc2-1c-1gb` → `vc2-2c-2gb` resize on that instance; a second try went
through, but a fresh instance at 2 GB is the reliable path, which is why the
plan is the default here rather than something to remember at deploy time.

telno generates its owner password on first boot and prints it once:

```sh
./vultr-demo.sh ssh 'cd /opt/cantus-estate/estate && docker compose logs telno | grep -i password'
```

Defaults are `VULTR_REGION=ewr`, `VULTR_PLAN=vc2-2c-2gb`. Override with the
environment: `VULTR_REGION=lax VULTR_PLAN=vc2-4c-8gb ./vultr-demo.sh up`.

### Checking it from outside

No shell required — the console answers the whole estate on `:8000`:

```sh
curl -s http://<ip>:8000/api/estate                 # switch node/relay, routes, lines, tape, products
curl -s -XPOST http://<ip>:8000/api/calls \
     -H 'content-type: application/json' \
     -d '{"from":"demo@estate.local","to":"101@estate.local"}'
```

The call ends `no-answer` while nothing is registered on 101, and appears on the
console's tape with its route (`demo-front-desk`). Address the callee as
`101@estate.local`, not `101`: the demo routes match `to: "101@*"`, so a bare
extension matches no route and the tape shows an empty route — which is how the
first live check fooled itself.

Unauthenticated switch calls are expected to fail: `GET /v1/status` answers
`401 unauthorized` and `/ari/asterisk/info` answers 401. That is the control
token doing its job, not a broken demo.

### When port 22 stops answering

A live run produced the confusing shape: `:8000` served requests while `:22`
timed out on both the /32 allowlist and a temporary 0.0.0.0/0 rule. The instance
was healthy the whole time; port 22 was being throttled upstream, which a tight
retry loop makes worse. Two things follow, both in the script:

- the SSH wait in `deploy`/`up` backs off (5 s, then 10 s, then 20 s) instead of
  retrying every 5 s for five minutes straight;
- the SSH firewall rule is rewritten with `PATCH` when the caller's address has
  changed (the rules endpoint answers `PUT` with 405), because a rule that
exists with the wrong source looks configured and still locks you out.

If 8000 answers and 22 does not, wait a minute and rerun
`./vultr-demo.sh deploy <ip>`; `down` needs only the API, never SSH.

## Other commands

| | |
| --- | --- |
| `status` | instance state and the URLs |
| `ip` | just the address (scriptable) |
| `logs` | last 40 lines of the estate boot log |
| `ssh [cmd]` | shell on the instance, or one command |
| `trunk <host> <user> <pass> [did]` | give the gateway a carrier and wait for the registration |
| `pack [file]` | build the deployment archive without deploying (works offline) |
| `deploy <ip>` | deploy to an instance you created yourself — needs no API key |
| `down` | destroy the instance |
| `down --purge` | ...and the firewall group and SSH key |

## Calling the PSTN

The estate's only SIP speaker is the `gateway` container. Cantus reaches it as
an ordinary endpoint (`voipms@gateway`) through the relay, so the switch dials a
trunk exactly the way it dials a line; SIP and RTP exist only between the
gateway and the carrier.

Two tools test it without a carrier account, because "the gateway is up" is not
the same claim as "a call works":

```sh
# inbound: a real INVITE for the DID, real SDP, real PCMU audio
node estate/tools/sip-probe.js --gateway <ip>:5060 --did 14132642700 --ring 15

# outbound: a carrier that challenges REGISTER and answers INVITEs
node estate/tools/sip-fake-carrier.js --port 5070 --username demo --password demo
```

The probe prints `180 Ringing` when the switch is ringing a line and exits 0
only when the call was answered. The fake carrier is a stand-in for voip.ms:
point the gateway's `VOIPMS_SIP_HOST` at it (`VOIPMS_SIP_PORT=5070`, matching
username and password) to rehearse an outbound call end to end.

A line to ring is a third thing, and on a plain-HTTP origin the browser
softphone cannot provide it: `getUserMedia` is withheld outside `https://` and
`localhost`, so the page says so and never registers. `line-client.js` is the
same Cantus line without a browser — it registers, rings, answers, sends 20 ms
frames and dials, and exits 0 only when audio crossed in both directions:

```sh
# ring 101 and answer whatever the DID brings
docker run --rm --network cantus-estate_default \
  -v /opt/cantus-estate:/src:ro -e CANTUS_CONTROL_TOKEN="$TOKEN" \
  node:24-alpine node /src/estate/tools/line-client.js \
  --switch switch:8088 --ext 101 --answer --seconds 20

# the softphone's own dial, the same message the page sends
... line-client.js --switch switch:8088 --ext 101 --call 14134210134@estate.local
```

With those two running together the whole path is verified: `sip-probe` is the
carrier, `line-client` is the phone, and the gateway and switch are the ones
being tested.

For the real thing, hand the deployed gateway its sub-account in one command —
it writes the credentials into the box's `.env` (mode 600, never printed back),
restarts only that container, and exits non-zero unless the carrier accepted
the registration:

```sh
./vultr-demo.sh trunk atlanta.voip.ms 123456_demo '<sub-account password>' 14132642700
curl -s http://<ip>:7454/healthz      # {"ok":true,"registered":true,...}
```

The same values can be set by hand and applied with `estate/up.sh env`:

```sh
VOIPMS_SIP_HOST=atlanta.voip.ms
VOIPMS_SIP_USERNAME=123456_demo
VOIPMS_SIP_PASSWORD=...
VOIPMS_SIP_FROM_USER=14132642700     # outbound caller ID: the trunk's DID
VOIPMS_SIP_DOMAIN=atlanta.voip.ms
PUBLIC_IP=<the box's public address>
```

`PUBLIC_IP` is what goes in the Contact header and the SDP: without it the
carrier is told to send audio to a Docker address it cannot reach. Inbound
routing is the DID's business, not the gateway's — point the DID at the
sub-account (or at `sip:<did>@<box ip>:5060`) and the gateway passes it to the
switch, where the generated `did-<number>` route decides which line rings.

## When the API refuses

Vultr API keys can be restricted to a list of source addresses, and the answer
says so explicitly:

```
vultr: GET /ssh-keys?per_page=200 -> 401
{"error":"Unauthorized IP address: 203.0.113.7","status":401}
```

Either allowlist the address you deploy from (Vultr → Account → API → Access
Control) and re-run `up`, or skip the API entirely:

1. create an Ubuntu 24.04 instance in the Vultr web UI;
2. add the public key `estate/tools/.vultr-key.pub` to it (paste it into the
   "SSH Keys" box while creating the instance);
3. open 22, 8000, 8188, 8090 tcp and 7443, 7444 udp in its firewall;
4. `./vultr-demo.sh deploy <ip>`.

The second path does exactly what `up` does after the instance exists: pack,
upload, run `estate/up.sh`, wait for the console, write the motd.

## What it creates on your account

- one firewall group `cantus-estate-demo`, reused on later runs;
- one SSH key `cantus-estate-demo` (the key pair itself is generated into
  `tools/.vultr-key` / `.vultr-key.pub`, git-ignored);
- one instance labelled `cantus-estate-demo`, tagged `cantus-estate`,`demo`.

The firewall opens exactly what the demo serves:

| port | why |
| --- | --- |
| 22/tcp | SSH, limited to the address you ran the script from when it can be discovered |
| 8000/tcp | the estate console |
| 8188/tcp | switch control API, ARI surface and the browser softphone socket |
| 8090/tcp | telno |
| 7443/udp | Cantus signalling and media |
| 7444/udp | Cantus relay |

`down` deletes the instance, which takes the volumes with it: the telno
database, recordings and prompts live on that disk and nowhere else. That is
deliberate — this is a demo box, and there is no backup step to get wrong.

The script records what it owns in `tools/.vultr-demo.json` so `status`, `logs`,
`ssh` and `down` do not guess.

## No account?

The same estate runs anywhere Docker runs:

```sh
cd estate && ./up.sh
```

`vultr-demo.sh` is a convenience around that, not a second deployment.

`up.sh` generates its secrets without assuming Node is installed: Node when it
is there, `openssl rand`, then `/dev/urandom`. A fresh cloud box has Docker and
no Node, and the first deploy died on `node: not found` after writing an `.env`
of empty values that compose then refused to interpolate.
