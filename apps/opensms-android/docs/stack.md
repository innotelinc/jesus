# OpenSMS in the Innotel Platform Stack

**Role: CommunicationOps** — Turn an Android phone into a local SMS API server.

Part of the [Innotel Platform Stack](https://github.com/innotelinc/innotel-platform-stack).
The canonical definition of the stack, its shared layers and their owners lives
there; this file records only what OpenSMS does inside it.

## Boundaries

### Owns

- the Android SMS app
- the local HTTP API
- send and receive routing

### Consumes

- the Android telephony stack
- Cerulean (only where a deployment fronts it)
- NPM Edge (optional public route)

### Does not own

- the carrier
- identity (Cerulean)
- message storage beyond the device

## Service map

| Component | Technology | Job |
| --- | --- | --- |
| OpenSMS | Node.js / TypeScript | Turn an Android phone into a local SMS API server. |
| Identity | Cerulean Authentik | Sign-in and role claims, where the repo has a UI |
| Secrets | Cerulean Vault (KV v2) | Production credentials, referenced as `vault://` |
| Trust | Cerulean | DNS, TLS and the public hostname |
| Edge | NPM Edge | The public route in front of the service |

## In the ecosystem

- **Identity** comes from Cerulean Authentik; this repo holds no second account
  table and no password of its own.
- **Secrets** come from Cerulean Vault. `.env` is local only and is never
  committed; a `vault://` reference is resolved by the deployment.
- **Trust and edge** are Cerulean's and NPM Edge's. This repo does not write DNS
  records or call the NPM API directly.
- **Storage, billing and telephony** belong to ONYX, Magnate and Zeus
  respectively; OpenSMS consumes them only where the boundaries above say
  so.

## See also

- [README](../README.md)
- [Innotel Platform Stack](https://github.com/innotelinc/innotel-platform-stack)
