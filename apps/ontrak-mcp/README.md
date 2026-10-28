# ontrak-mcp

[![CI](https://github.com/innotelinc/ontrak-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/innotelinc/ontrak-mcp/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

> **ontrak-mcp** is the Model Context Protocol **client and tool bridge** that lets an
> agent console use tools living in another process — a reverse-engineering toolkit, a
> database tool, a browser driver — anything that speaks MCP over stdio, with no runtime
> dependency. It is the MCP layer from [OnTrak Genie](https://ontrak.innotel.us),
> extracted so it can be reviewed, reused and versioned on its own, and it rides the
> [Innotel Platform Stack](https://github.com/innotelinc/innotel-platform-stack) for the
> identity, secrets and trust its console already runs on.
>
> **Landing page:** [innotelinc.github.io/ontrak-mcp](https://innotelinc.github.io/ontrak-mcp/)

Shipped with a reference **server** to try it against, and no dependencies — Node's
standard library only — because the wire contract this needs is four methods wide.

## Why ontrak-mcp

| Problem | Answer |
| --- | --- |
| An SDK can be larger than the protocol it wraps. | Four methods implemented directly, with no runtime dependency. |
| A tool server can die mid-call. | The call is rejected with the reason and the next call starts a fresh child. |
| A server-initiated request can block forever. | Unknown client methods are answered, not dropped. |

Its place in the stack is [docs/stack.md](docs/stack.md); the canonical
definition of the shared layers is the
[Innotel Platform Stack](https://github.com/innotelinc/innotel-platform-stack).

## Why not the SDK

The wire contract this needs is four methods wide — `initialize`,
`notifications/initialized`, `tools/list`, `tools/call`. A dependency larger than
the protocol it wraps is a heavier thing to keep patched than the protocol itself,
and the awkward half of MCP is not the message shapes but the things around them,
which an SDK does not handle either. Those are the parts written carefully here:

- **a server that dies mid-call** — rejected with the reason, and the next call
  starts a fresh child rather than reusing a corpse;
- **a request the *server* sends the client** (roots, sampling) — answered with
  `method not found` instead of dropped, because a server waiting on a reply blocks
  forever;
- **a reply for an id nobody is waiting on** — ignored, rather than resolving the
  wrong promise;
- **timeouts that differ by shape** — a short one for a handshake, a long one for a
  call that is real computation (a decompile is not a network request);
- **a URL server in a stdio-only client** — reported, not silently tool-less.

## Install

```sh
npm install ontrak-mcp
```

Or vendor the three source files: `src/mcp.ts`, `src/mcp-config.ts`,
`src/mcp-tools.ts`. They import only `node:child_process` and `node:fs`.

## Use

```ts
import { primeMcpTools, mcpToolSnapshot } from "ontrak-mcp";

// Once per turn, before the model's tool list is built.
await primeMcpTools();

// Every bridged tool, in your console's own tool shape.
for (const tool of mcpToolSnapshot()) {
  console.log(tool.name, "—", tool.description);
  // tool.inspect is present only when approval is required.
}
```

A server's tools arrive as `mcp__<server>__<tool>`:

```
mcp__rea__open_binary
mcp__rea__analyze_function
mcp__echo__echo
```

Two per-server tools named `analyze` therefore never collide, and the name says
where a call is going.

### Approval

A tool the server marks **`readOnlyHint`** runs without asking: the server has
declared it changes nothing, and the bridge takes that declaration at its word.
Everything else — including a tool that declares nothing — gets an `inspect`, so a
console with an approval flow treats it as a change. Erring this way is deliberate:
an unannotated tool may well write.

## Configure

Servers come from two places:

| Source | Shape | Why |
| --- | --- | --- |
| `MCP_SERVERS` | JSON array, or `{"mcpServers": {…}}` | the deployment's own list |
| `MCP_CONFIG_PATHS` | comma-separated files, read in order | the agent ecosystem's shared registration files |

`MCP_CONFIG_PATHS` defaults to `/root/.agents/mcp.json` and
`$AGENT_DATA_DIR/mcp.json`. That first path is the one the agent ecosystem's
installers write to — so a tool whose own `setup` registers an MCP server is
registering with this bridge too, and nobody configures it twice.

```json
{ "mcpServers": { "rea": { "command": "rea", "args": ["--mcp"] } } }
```

`command` and `args` are spawned directly, never through a shell.

Other settings: `MCP_STARTUP_TIMEOUT_MS` (default `20000`),
`MCP_TOOL_TIMEOUT_MS` (default `300000`).

A malformed setting or config file is **reported** (`mcpProblems()`) and skipped —
one bad entry must not stop the console, or the other servers, from loading.

## The reference server

```sh
node examples/echo-server.mjs        # a three-tool MCP server, no dependencies
```

Point `MCP_SERVERS` at it to try the bridge end to end:

```sh
MCP_SERVERS='[{"name":"echo","command":"node","args":["examples/echo-server.mjs"]}]' \
  node -e "import('ontrak-mcp').then(async m => { await m.primeMcpTools(); console.log(m.mcpServerNames(), m.mcpToolSnapshot().map(t => t.name)); })"
```

Its `echo` tool declares `readOnlyHint: true`; its `write_note` declares nothing.
That difference is the whole approval rule, visible in one file.

## Test

```sh
npm run check      # typecheck, build, then the suite
```

The suite runs against a fake server that *misbehaves on purpose*: one that never
answers the handshake, one that fails a call, one that sends a request to the client
mid-call, and a config that is malformed. The happy path is the easy half.

## Compatibility

Node 22.19+, 24.11+, or 26+. Stdio transport only. This is a **client**: to be
useful it needs a server — [REA](https://github.com/innotelinc/rea) is the one it
was written for, and the fork carries a
[deployment recipe](https://github.com/innotelinc/rea/tree/ontrak/genie-integration/deploy/ontrak-genie)
for running it (with Ghidra) inside an Alpine container.

## License

MIT — see [LICENSE](LICENSE).
