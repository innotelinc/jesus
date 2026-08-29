# Networking & Port Forwarding

How to expose the capstone stack to callers and operators. The stack splits
into three tiers:

1. **Nginx Proxy Manager** — reverse-proxy the web/API surfaces over HTTPS.
2. **Router port-forward** — raw UDP/TCP for SIP/RTP telephony (and the NPM
   entry itself).
3. **Loopback only** — credentials-bearing control/DB planes that must never
   be exposed.

The port inventory below is the actual published mapping from
`docker-compose.yml` (the PBX/Asterisk service lives in the same file).

---

## 1. Nginx Proxy Manager — proxy hosts (HTTPS)

Terminate TLS in NPM and forward to these local ports. Do **not** expose the
raw port to the internet.

| Service | Host port | NPM forward-to | Suggested hostname |
|---|---|---|---|
| FreePBX web UI | `80` | `http://127.0.0.1:80` | `voice.<domain>` |
| n8n | `5678` | `http://127.0.0.1:5678` | `n8n.<domain>` |
| Grist | `8484` | `http://127.0.0.1:8484` | `grist.<domain>` |
| SigNoz UI | `3301` | `http://127.0.0.1:3301` | `signoz.<domain>` |
| dograh API | `8000` (host-mode) | `http://127.0.0.1:8000` | reverse-proxy via your own NPM |
| dograh UI | `3010` | `http://127.0.0.1:3010` | reverse-proxy via your own NPM |
| OmniRoute dashboard (optional) | `20128` | `http://127.0.0.1:20128` | keep internal |

Notes:

- **Enable WebSockets** on the n8n and SigNoz proxy hosts — their UIs use
  WSS (and dograh's UI does too, if you proxy it).
- **n8n public webhook** — dograh POSTs the grading webhook to
  `http://127.0.0.1:5678` (same host), so it works internally today. Only
  proxy n8n if you want remote editor access or webhooks from outside the
  LAN.
- **OmniRoute (`20128`)** holds the LLM API key and is bound `0.0.0.0` only
  so n8n can reach it via `host.docker.internal:20128`. Keep it **internal**,
  do not proxy it.
- **dograh API (`8000`)** runs in host network mode on its original uvicorn
  port — the PBX reaches it back via `host.docker.internal:8000` media
  WebSocket and the n8n container calls it via the LAN IP. The **dograh UI
  (`3010`)** is the separate Next.js frontend. No nginx route is bundled —
  reverse-proxy the UI/API with your own Nginx Proxy Manager if you want
  remote access.

---

## 2. Router port-forward — raw (telephony + NPM entry)

These bypass NPM and go straight from the router to the host. The critical
ones are SIP + RTP so an external carrier/softphone can reach Asterisk.

| Port | Proto | Purpose |
|---|---|---|
| `5060` | UDP | SIP signalling |
| `5061` | TCP | SIP over TLS (only if you do TLS trunks / WebRTC) |
| `10101–10120` | UDP | RTP media (matches the compose mapping; ~10 concurrent calls) |
| `80` / `443` | TCP | NPM itself (public HTTPS entry) |
| `8089` | TCP | PJSIP WebSocket / WSS (browser/WebRTC softphones only) |
| `3478` | TCP/UDP | Coturn TURN listener |
| `49152–49251` | UDP | Coturn relay range |

> ⚠️ Only the Asterisk-facing ports need router exposure. Do **not** forward
> `8088` (ARI), `5038` (AMI), `5432` (postgres), `6379` (redis),
> `9000`/`9001` (minio), `3301`, `8484`, `5678` — those are
> credentials-bearing control/DB planes. They stay loopback (or go through
> NPM with auth, never raw).

### RTP note

The RTP range is `10101-10120/udp` — 20 ports ≈ 10 concurrent calls,
configurable via `FREEPBX_RTP_PORT_START` / `FREEPBX_RTP_PORT_END` in
`.env`. `10000/tcp` in the same container is the FreePBX **Webmin** panel
(configurable via `FREEPBX_WEBMIN_PORT`), not RTP; forward only the UDP
range for media.

---

## 3. Loopback only (no NPM, no router)

Bound to `127.0.0.1` in compose — reachable only from the host (and dograh,
which runs in host mode).

| Port | Service |
|---|---|
| `5432` | postgres |
| `6379` | redis |
| `9000` / `9001` | minio API / console |
| `8880` | kokoro TTS |
| `8001` | speaches STT (host `8001` → container `8000`) |
| `8088` | Asterisk ARI (control plane — never expose) |
| `5038` | Asterisk AMI (never expose) |
| `4317` / `4318` | OTel gRPC / HTTP ingest |
| `8888` / `8889` | otel-collector metrics |
| `19000` / `8123` | ClickHouse native / HTTP |
| `9093` | alertmanager |
| `8080` | NocoDB (optional — switch off Grist to use it) |
| `10000` (TCP) | FreePBX Webmin (optional) |
| `3478` (TCP/UDP) | Coturn TURN listener |
| `49152–49251` (UDP) | Coturn relay ports |
| `3000` | pbx-portal (optional, `--profile portal`) |

---

## Quick reference

```
Internet ──► Router
              ├─ 5060/udp ───────────► Asterisk (SIP)
              ├─ 10101-10120/udp ───► Asterisk (RTP)
              ├─ 3478/tcp+udp ──────► Coturn (TURN)
              └─ 49152-49251/udp ───► Coturn (relay)
              └─ 443/tcp (HTTPS) ────► NPM ──► n8n:5678, grist:8484,
                                       ├──► signoz:3301, freepbx:80
                                       └──► dograh-ui:3010 → api:8000 (your own NPM)
```

**Rule of thumb:** if a port is `127.0.0.1:`-bound in compose, it stays
loopback. If it's `0.0.0.0:`-bound, it's a NPM proxy candidate (or, for
telephony, a router forward). Asterisk's SIP/RTP/WS ports are the only ones
that must cross the router raw.
