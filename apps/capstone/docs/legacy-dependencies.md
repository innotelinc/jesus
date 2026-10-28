# Legacy dependencies & modernization

Capstone vendors or depends on several components that are aging out of
upstream support. This is the working inventory of what is currently legacy,
why, and what to move to — with migration notes. It is a roadmap, not a
promise: every swap below should be made deliberately, in its own release.

## Storage decision — MinIO stays for now

MinIO is still the live object store for the `voice-audio` bucket. Dograh writes
recordings and transcripts through the S3-compatible `MINIO_*` settings; the NPM
edge serves playback URLs, backups include the MinIO volume, and Zeus consumes
the same recording path. **Do not remove or replace it in place yet.** ONYX is the
planned platform owner, but migration requires an S3-compatible endpoint, bucket
and access-policy parity, signed/public URL verification, and a tested backup/
restore cutover. The migration target is therefore an ONYX-backed S3 adapter behind
the unchanged `MINIO_*` contract, followed by a read-after-write and restore
verification before the MinIO volume is retired.

| Component (current) | Why it is legacy | Proposed replacement | Migration notes |
|---|---|---|---|
| FreePBX 17 + Asterisk 22 fullstack image (PHP 7.4/8.2 `mod_php`, monolithic GUI, custom `entrypoint-dograh.sh` surgery) | PHP 7.4 is EOL; the image requires ongoing boot-time patches (Apache user flip, `fwconsole chown` safety nets, `s///`-sed hardening) that are brittle across image rebuilds | Asterisk LTS with an ARI-first config (no FreePBX GUI), or [Wazo Platform](https://wazo-platform.org) for a container-native PBX | Keep FreePBX while the dograh ARI wiring depends on its dialplan GUI; move to pure `pjsip.conf` + ARI when the last GUI-managed route is migrated. See `pbx/README.md` for the current wiring. |
| SigNoz v0.138 (unified binary + separate ClickHouse Keeper, 2024-era) | ~~Old release line; the `signoz` unified binary was a transition build.~~ <br>**REMOVED (2026-09):** the pipeline only needs the latency numbers, and storing every span to get them cost more than the numbers were worth — measured, that cluster held ~400 KiB of telemetry while pinning ~125% of a core and 1.18 GiB RSS (its 2 GiB cap). | **DONE:** `otel-collector`'s `spanmetrics` connector turns each span into a RED histogram and drops the span; `prometheus` stores the metrics (time *and* size retention) and `grafana` charts them. No trace or log store runs. | Dashboards re-authored as `grafana/dashboards/pipeline-latency.json`. The one thing span attributes gave that span metrics cannot — a histogram value read from an attribute (`metrics.ttfb`) — is now measured where it is known: the TTS shim's `tts_shim_ttfa_seconds`. The collector version is pinned deliberately (see `otel-collector-config.yaml`): the `spanmetrics` unit flips to seconds in newer contrib builds, which would silently rename every series a dashboard queries. |
| Grist + NocoDB dual dashboard | ~~Two overlapping record stores~~ **DONE:** NocoDB profile removed; Grist is the sole record store. | ~~Pick Grist~~ Grist is default. | ~~Remove `nocodb` service~~ Removed. |
| n8n Community Edition configured with legacy 2.x env knobs (`N8N_BLOCK_ENV_ACCESS_IN_NODE`, `N8N_DIAGNOSTICS_ENABLED`, custom OTel `n8n.Dockerfile`) | Config style predates n8n's current settings names and the maintained OTel SDK | Current n8n release + the official `@n8n/n8n` OTel setup; drop the custom Dockerfile once upstream covers auto-instrumentation | Keep the `n8n-import` one-shot (import + restart + webhook probe) — it is the part n8n still doesn't do on its own. |
| dograh platform maintained as a forked source (`DOGRAH_AGENT_REPO` clone, `sync-dograh-fork.sh` re-applying Capstone patches) | Fork drift: every upstream sync is a manual re-apply; the fork carries Capstone-only patches | Track upstream `dograh-hq/dograh` directly and upstream the Capstone patches (ARI wiring, self-hosted interview stack) as contributions | Meanwhile the compose file runs prebuilt images with `DOGRAH_*_IMAGE` overrides, so the fork can be swapped out without touching the stack. |
| Python stdlib HTTP clients (`urllib`) in automation scripts (`npm-proxy-hosts.py`, `dograh_wire.py`, `bootstrap_dograh_route.py`, `sync_dograh_routes.py`) | No retries/timeouts/pools; error handling is hand-rolled; `urllib` is fine but dated | `httpx` (or `requests`) with typed config + retries, shared in a small `scripts/lib` | Convenience only — the scripts are deliberately dependency-free so a fresh host can run them before `pip install`. Move only if the retry logic keeps growing. |
| ClickHouse 25.12.5 pinned with hand-written `clickhouse-config.yaml` / `clickhouse-keeper.yaml` | ~~Single-node cluster config written by hand~~ **REMOVED (2026-09)** along with SigNoz: neither the traces nor the metrics need an OLAP store any more. | **DONE:** Prometheus (in this compose) for metrics; nothing for traces. | `clickhouse-config.yaml`, `clickhouse-keeper.yaml` and `signoz-pipeline-latency-dashboard.json` are the leftover files of the removed cluster — delete them once no host still carries the stack. |
| Coturn `:latest` + fixed relay range (49152–49251) | Untagged `latest` image; the relay range is sized for ~10 concurrent calls | Pin a Coturn release tag; scale the relay range with expected call volume | Trivial: add `coturn/coturn:4.6.4` (or newer) and re-test WebRTC with `scripts/webrtc-register-test.py`. |
| Docker Compose v2 with one `docker-compose.yml` + per-service Dockerfiles | Compose is current and fine at single-node scale, but builds are not reproducible (no lockfile/digests) | Keep Compose; add pinned image digests (or move to `docker buildx bake`) for reproducible builds | The release pipeline already builds the Capstone images on tags — add digest pinning when you standardize base images. |
| Dashboard SPA (React/Vite) with mock-heavy `lib/data.ts` fallbacks | The frontend ships static mock data that can drift from the real API | Keep the live `dashboard-backend` aggregator as the single source of truth; purge mocks once every page is API-backed | Not urgent — mocks only render when the aggregator is unreachable. |
| `docker-compose.dograh.yml` (standalone hybrid-box compose) | Second compose path with its own drift | Fold into the main compose (as `docker-compose.dograh-build.yml` already is for builds) or delete | Verify nothing references it before removing. |

## Deprecation policy

- Nothing above is removed in this release; the list is the plan.
- Each replacement should land behind its own flag/env override first (the
  stack is already env-overridable for images: `DOGRAH_*_IMAGE`,
  `N8N_IMAGE`, `WORKFLOW_STUDIO_IMAGE`, `DASHBOARD_IMAGE`,
  `DASHBOARD_API_IMAGE`, `FREEPBX_IMAGE`, `AUTHENTIK_VERSION`).
- Run `scripts/smoke-test.sh` after any swap.
