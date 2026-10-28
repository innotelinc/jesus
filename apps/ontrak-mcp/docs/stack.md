# ontrak-mcp in the Innotel Platform Stack

**Role: CodeOps** — A dependency-free MCP client and tool bridge for agent consoles.

Part of the [Innotel Platform Stack](https://github.com/innotelinc/innotel-platform-stack).
The canonical definition of the stack, its shared layers and their owners lives
there; this file records only what ontrak-mcp does inside it.

## Boundaries

### Owns

- the MCP client and stdio lifecycle
- the tool bridge
- the reference server
- the timeout and redaction rules

### Consumes

- MCP servers over stdio
- OnTrak Genie or another agent console
- Cerulean Vault (deployment secrets, if hosted)

### Does not own

- the agent loop
- the tools themselves
- identity or storage (Cerulean, ONYX)

## Service map

| Component | Technology | Job |
| --- | --- | --- |
| ontrak-mcp | Node.js / TypeScript | A dependency-free MCP client and tool bridge for agent consoles. |
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
  respectively; ontrak-mcp consumes them only where the boundaries above say
  so.

## See also

- [README](../README.md)
- [Innotel Platform Stack](https://github.com/innotelinc/innotel-platform-stack)
