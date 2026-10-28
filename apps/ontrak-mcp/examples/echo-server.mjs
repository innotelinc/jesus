#!/usr/bin/env node
/**
 * A minimal Model Context Protocol server, in one file and with no dependencies.
 *
 * Two reasons this ships with the client:
 *
 *   1. **a runnable example** — `node examples/echo-server.mjs` is something to
 *      point `MCP_SERVERS` at, so the bridge can be tried without installing a
 *      real toolkit first;
 *   2. **the protocol, stated once** — a server is a handshake, a tool list and a
 *      call handler. Reading that here is faster than reading a specification,
 *      and it is the same contract the test suite's fake server obeys.
 *
 * The tools it exposes are deliberately boring, but they are annotated the way a
 * real server should be: `echo` declares itself read-only, while `write_note`
 * declares nothing — which is exactly what makes the bridge require approval for
 * one and not the other.
 */

import readline from "node:readline";

/** Where `write_note` keeps what it writes. */
const notes = new Map();

const TOOLS = [
  {
    name: "echo",
    description: "Return the text it was given. Read-only.",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string", description: "Text to return" } },
      required: ["text"],
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "write_note",
    description: "Store a note under a key. Changes nothing outside this process, but declares no hint, so a client should ask first.",
    inputSchema: {
      type: "object",
      properties: {
        key: { type: "string" },
        value: { type: "string" },
      },
      required: ["key", "value"],
    },
  },
  {
    name: "list_notes",
    description: "List the keys of the notes stored so far. Read-only.",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true },
  },
];

/** One content block, which is the only shape this server ever returns. */
const text = (value) => ({ content: [{ type: "text", text: String(value) }] });

function callTool(name, args) {
  switch (name) {
    case "echo":
      return text(args?.text ?? "");
    case "write_note": {
      if (typeof args?.key !== "string" || typeof args?.value !== "string") {
        return { isError: true, content: [{ type: "text", text: "key and value are required" }] };
      }
      notes.set(args.key, args.value);
      return text(`stored ${args.key}`);
    }
    case "list_notes":
      return text([...notes.keys()].join(", ") || "(no notes)");
    default:
      return { isError: true, content: [{ type: "text", text: `no such tool: ${name}` }] };
  }
}

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);

readline.createInterface({ input: process.stdin }).on("line", (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (message === null || typeof message !== "object") return;

  // A notification carries an id of `null` (or none) and is never answered.
  const id = message.id;
  if (message.method === "notifications/initialized") return;
  if (id === undefined || id === null) return;

  switch (message.method) {
    case "initialize":
      send({
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "echo", version: "1.0.0" },
        },
      });
      return;
    case "tools/list":
      send({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
      return;
    case "tools/call": {
      const params = message.params ?? {};
      send({ jsonrpc: "2.0", id, result: callTool(params.name, params.arguments ?? {}) });
      return;
    }
    default:
      send({ jsonrpc: "2.0", id, error: { code: -32601, message: `unknown method: ${message.method}` } });
  }
});
