# Retiring ord-voice

`ord-voice` (`66.42.116.17`, the `capstone` LXC) was the previous Capstone/Zeus/Dograh
box. Everything it held that Christ actually needs has been moved onto Christ
(`45.77.221.158`). This document records what moved, where it now lives, what was
deliberately dropped, and what to confirm before the instance is destroyed.

State at the time of the move: **migrated, verified** — the box can be retired.

## What moved

| Data | On ord-voice | Now on Christ | Verified by |
| --- | --- | --- | --- |
| Grist doc `wj4tZRiakfe69mKFHgU9rz` — `Interviews`, 45 rows across 7 tracks | `capstone_grist_data/docs/` | `christ-grist`, volume `grist-data` | `GET /api/interviews/reports` returns 45 reports, `configured: true` |
| n8n database — workflow *Interview Grader*, 12 executions, 1 credential | `capstone_n8n_data` | `christ-n8n`, volume `n8n-data` | `n8n list:workflow` → `interview-grader-workflow\|Interview Grader` |
| Call recordings, bucket `voice-audio` (411 objects, 654 MB) | `capstone_minio-data`, `dograh_minio-data` | `christ-dograh-minio`, volume `dograh-minio-data` at `/data/voice-audio` | `du -sh /data/voice-audio` → 654M |
| OmniRoute configuration — `storage.sqlite`, `server.env`, db backups | `capstone_omniroute_data` | `/opt/christ/import/capstone_omniroute_data` | archive extracted, 3.9 MB |
| Zeus portal database + 4 dated backups | `zeus-portal-data/pbx.db*` | `/opt/christ/import/zeus-portal-data` | archive extracted, 4.9 MB |
| FreePBX databases — `asterisk`, `asteriskcdrdb`, `avantfax` | `pbx-mariadb-data` | `/opt/christ/import/pbx-mariadb-data` | archive extracted, 245 MB |
| FreePBX Asterisk config and fax spool | `pbx-asterisk-config`, `pbx-asterisk-spool` | `/opt/christ/import/pbx-asterisk-config`, `.../pbx-asterisk-spool` | archive extracted, 2.8 MB + 39 MB |
| Old voice-edge config | `voice-edge-data` | `/opt/christ/import/voice-edge-data` | archive extracted, 668 KB |

The `import/` archives are raw volume contents, not live services. They exist so the
instance can be destroyed without losing history; nothing in the stack reads them.

## What was empty

These volumes looked like data sources and contained nothing worth keeping:

- `dograh_postgres_data` (60 MB) — one `postgres` database with only `template0`/`template1`.
  No agents, no workflows, no phone numbers.
- `capstone_postgres_data` (61 MB) — same: cluster defaults only.
- `dograh_grist_data` — Grist doc directory empty.
- `dograh_n8n_data` (24 MB) — holds a second copy of the *same* `Interview Grader`
  workflow with zero executions and zero credentials. The copy with the 12 executions
  is the one that moved.

## What was dropped, and why

| Item | Size | Reason |
| --- | --- | --- |
| `dograh_speaches_models` (Kokoro-82M, faster-whisper-small) | 802 MB | Model weights, re-downloadable. Christ speaks through the Piper `tts-shim` instead. |
| `dograh_clickhouse_data`, `dograh_signoz_postgres_data`, `dograh_keeper_data` | 636 MB | Signoz/ClickHouse telemetry for the old runtime. |
| `capstone_prometheus_data`, `capstone_grafana_data` | 415 MB | Monitoring history of the retired stack; Christ's board reports health itself. |
| `pbx-asterisk-logs`, `pbx-asterisk-sounds`, `pbx-freepbx-www` | 3.3 GB | Stock sounds, logs and the FreePBX web root. |
| OAuth2 proxy gates (`pbx-sso`, `n8n-sso`, `grist-sso`, `workflow-sso`, `grafana-sso`, ports 14010–14014) | — | The old stack's single sign-on. Christ's console carries its own auth. |
| `cloudflared-tunnel` | — | A quick tunnel (`tunnel --url http://api:8000`) serving a random `trycloudflare.com` hostname against a service that no longer exists. **No estate domain resolves to it** — the seven `telno.*` domains point at `45.77.221.158:443` and are terminated by `christ-edge`. |
| `capstone_probe-bin`, `capstone_sandbox-tls`, `capstone_redis_data`, searxng config | ~1.3 MB | Helper binaries and caches for services Christ does not run. |

## Before destroying the instance

1. **Domains** — none of the seven depend on ord-voice. Verified on 2026-10-30: the
   edge already holds a valid Let's Encrypt certificate for every one of them and
   answers `200` (or `302` to `/d/telno.directory`) when the name is pointed at
   `45.77.221.158`. The zones were rebuilt in Vultr DNS with the apex `A`, `www`,
   `CAA`, SPF and DMARC, and answer authoritatively from `ns1.vultr.com`. What is
   still missing is the delegation: the seven names are registered at Namecheap and
   still list the retired `ns1.<zone>`/`ns2.<zone>`, so public resolvers ask a host
   that no longer answers. Changing that is the registrar's, not the box's — see
   [domains.md](domains.md).
2. **Carrier** — the SIP trunk registers on `christ-gateway` and the DID
   `14132642700` rings line 101; the IAX trunk (`235662_iax`) registers on
   `christ-fax` and owns `7745057136` / `4135614101`.
3. **Nothing points at ord-voice** — no A or CNAME record in any estate zone refers
   to `66.42.116.17`.
4. **Keep the archives** — if the import volumes matter long-term, copy
   `/opt/christ/import/` off the box before Christ itself is ever rebuilt. They are not
   part of `christ/deploy/` and are not captured by the deployment.
5. **Revoke the transfer key** — the copy ran over a key minted on ord-voice
   (`/root/.ssh/christ_k`) whose public half was appended to Christ's
   `/root/.ssh/authorized_keys`. Destroying ord-voice makes it unusable, but remove
   that line first: until then ord-voice holds root on Christ.

## Reading the archives

```bash
ssh root@45.77.221.158 'ls /opt/christ/import/'
# Grist doc: copy the .grist file into the grist volume's docs/ directory when Grist is stopped.
# n8n is already live; the archive exists only for the other stores.
```
