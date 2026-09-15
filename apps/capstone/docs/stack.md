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
