# 🎙️ Capstone — Platform Stack Role

**Classification: AgentOps**

Voice AI agents and telephony automation: AI receptionists, call screening, speech processing, and voice workflows.

This page declares Capstone's role in the
[**Innotel Platform Stack**](https://github.com/innotelinc/innotel-platform-stack) —
the canonical single-responsibility architecture. The stack is defined in exactly one
place; this page links each product to it and states what this platform owns, consumes,
provides, and explicitly does not own.

## Owns

- Voice AI agents
- Call screening
- AI receptionists
- Speech processing (STT/TTS)
- Voice workflows
- Telephony automation

## Provides

- Voice AI agent platform for the ecosystem

## Consumes

- Zeus — telephony (PBX/Asterisk/FreePBX) as the voice plane
- Authentik — identity, SSO, user management
- Cerulean Vault — secrets, API keys, service credentials
- Magnate — subscriptions and entitlements (`MAGNATE_PUBLIC_URL`; agents are
  a Magnate SKU — Capstone holds no Stripe keys)
- Cerulean — certificates and DNS for every `capstone.innotel.us` host
- NPM Edge — public routing, TLS termination at the edge

## Explicitly does NOT own

- Identity (Authentik)
- Secrets (Cerulean Vault)
- Billing (Magnate)
- Certificates / trust (Cerulean)
- Storage (ONYX)


> **Current state:** Capstone currently bundles its own PBX/Asterisk stack; convergence on Zeus as the voice plane is the target.
> See the [**Capstone ↔ Zeus convergence plan**](https://github.com/innotelinc/innotel-platform-stack/blob/main/docs/convergence-capstone-zeus.md)
> for the target architecture (Capstone standalone + Zeus add-on) and phased work.

## Roadmap — where Capstone stands (17 September 2026)

**Live and verified on the deployment (`.30`):**

- [x] **Voice core is up and attributed** — Postgres, Redis, MinIO, Dograh API
      (`/health` 200) and UI, dashboard API + console, Zeus FreePBX + portal +
      coturn on the shared host; Dograh's ARI connection to Zeus/FreePBX is
      active, so calls already ride the Zeus voice plane on this deployment.
- [x] **Observability restored after the capacity pass** — Prometheus (healthy),
      Grafana (healthy, SSO-gated), the OTel collector, and the provisioning that
      ships in-tree (`prometheus/prometheus.yml`, `grafana/dashboards/`).
- [x] **Dashboard bundle in sync** — the rebuilt `dashboard/dist` (hashed assets,
      monitoring/softphone views) is committed, so the repo builds what runs.
- [x] **Authentik-first sign-in** — the dashboard authenticates through Cerulean
      Authentik (`capstone-dashboard` provider); error codes surface on the login
      view instead of silent failures.

**Open, in priority order:**

1. **Zeus convergence phase 2 — retire the bundled PBX.** Compose still ships
      `zeus-freepbx` locally for standalone installs; the target is a
      Capstone-standalone profile that dials the Zeus add-on as the only voice
      plane. The structural-parity checklist is the gate.
2. **ONYX as the authoritative store.** `voice-audio` recordings, transcripts and
      backups still live on MinIO behind the `MINIO_*` contract (see
      `docs/legacy-dependencies.md`). Migration happens behind that same
      contract once ONYX's S3 compatibility, signed URLs and restore behavior
      are tested — apps should not notice the move.
3. **Vault-first secrets.** Like Monarch, this repo has no runtime resolver, so
      host `.env` carries resolved values; adopt the resolving-env sidecar when
      Cerulean offers it (`docs/stack.md` § Secrets).
4. **N8n + Grist restart posture.** Both were parked in the 17 Sep capacity pass
      and come back with `docker compose up -d n8n grist` — a compose profile
      (`--profile tools`) would make "dev tools on demand" explicit instead of
      always-on.


## Secrets (Cerulean Vault)

The platform's SecretOps is **Cerulean Vault** — HashiCorp Vault, KV v2, hosted by
Cerulean — with `vault://<mount>/<path>#<key>` references in `.env`:

```bash
MAGNATE_API_TOKEN=vault://cerulean/capstone#MAGNATE_API_TOKEN
```

Cerulean mints this stack's **path-scoped** token (its policy covers only
`cerulean/data/capstone`, never a sibling's secrets) and renews it in place. Copy
it to `./data/vault/token/capstone.token`, then move any plaintext values across:

```bash
VAULT_ADDR=http://<cerulean-host>:8200 \
  VAULT_TOKEN_FILE=./data/vault/token/capstone.token \
  VAULT_PREFIX=cerulean VAULT_PATH=capstone \
  python3 scripts/vault-migrate.py --from-env-file .env \
    --keys AUTHENTIK_CLIENT_SECRET,MAGNATE_API_TOKEN
```

`vault-migrate.py` never prints a value, unions with whatever is already at the
path (so a re-run is a no-op, not an overwrite), and accepts either `.env` or a
legacy Infisical workspace as its source.

A `vault://` value is the platform's reference *form*; it is resolved by whichever
layer consumes it (ONYX's Go services, Distro's Node control plane, Atlas at
setup). This repo has no runtime resolver, so `.env` must hold the resolved
value — a reference left in place reaches the container as a literal string.

## Golden rules

- **Authentik = Identity** · **Cerulean Vault = Secrets** · **Cerulean = Trust** ·
  **ONYX = Storage** · **Magnate = Revenue** · **NPM Edge = Edge** — everything else is a business function.
- No platform duplicates another's responsibility.
- No credit in commits, footers, or headers to anyone but the project owner.

---

*Capstone · AgentOps · [Innotel Platform Stack](https://github.com/innotelinc/innotel-platform-stack)*
