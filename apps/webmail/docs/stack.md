# Loomix Mail in the Innotel Platform Stack

**Role: CommunicationOps** — Email, calendars, contacts and files on your own infrastructure.

Part of the [Innotel Platform Stack](https://github.com/innotelinc/innotel-platform-stack).
The canonical definition of the stack, its shared layers and their owners lives
there; this file records only what Loomix Mail does inside it.

## Boundaries

### Owns

- the JMAP web client and its admin surface
- themes, plugins and the PWA shell

### Consumes

- Stalwart Mail Server over JMAP
- Cerulean (Authentik SSO, DNS, TLS)
- NPM Edge (public host)

### Does not own

- the mail server or its storage
- identity (Authentik)
- secrets (Cerulean Vault)

## Service map

| Component | Technology | Job |
| --- | --- | --- |
| Loomix Mail | Node.js / TypeScript | Email, calendars, contacts and files on your own infrastructure. |
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
  respectively; Loomix Mail consumes them only where the boundaries above say
  so.

## See also

- [README](../README.md)
- [Innotel Platform Stack](https://github.com/innotelinc/innotel-platform-stack)
