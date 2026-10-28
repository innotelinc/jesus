# REA in the Innotel Platform Stack

**Role: SecurityOps** — Reverse engineer anything: one MCP and CLI across binaries, apps and runtime behaviour.

Part of the [Innotel Platform Stack](https://github.com/innotelinc/innotel-platform-stack).
The canonical definition of the stack, its shared layers and their owners lives
there; this file records only what REA does inside it.

## Boundaries

### Owns

- the rea CLI and MCP server
- the Ghidra bridge
- the analysis skills and tool transcript

### Consumes

- Ghidra and the host's native analysis tools
- OnTrak Genie / Engineer as the agent console
- Cerulean Vault (deployment secrets)

### Does not own

- the agent loop (Genie)
- the binaries under analysis
- identity (Cerulean)

## Service map

| Component | Technology | Job |
| --- | --- | --- |
| REA | Node.js / TypeScript | Reverse engineer anything: one MCP and CLI across binaries, apps and runtime behaviour. |
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
  respectively; REA consumes them only where the boundaries above say
  so.

## See also

- [README](../README.md)
- [Innotel Platform Stack](https://github.com/innotelinc/innotel-platform-stack)
