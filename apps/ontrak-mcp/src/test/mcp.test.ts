import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

/**
 * The protocol, the bridge, and the ways both go wrong quietly.
 *
 * The cases that matter here are not the happy path: a bridge that only worked
 * when everything answered would be one that hides a dead server behind an empty
 * tool list. So each failure mode has a test — a server that never handshakes, a
 * server that fails a call, a request the *server* makes to the client mid-call,
 * and a configuration that is malformed — and the approval rule is asserted in
 * both directions, because a tool that writes being waved through is the whole
 * risk of delegating to another process.
 *
 * The environment is set before the imports because `config.ts` reads it once.
 */
const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "ontrak-mcp-test-"));
process.env.AGENT_DATA_DIR = path.join(scratch, ".agent");

/**
 * A fake MCP server, as a script.
 *
 * Written out rather than inlined so it speaks the wire protocol exactly:
 * newline-delimited JSON-RPC on stdio, a handshake, a listing, then calls.
 * `MODE` selects the behaviour under test.
 */
const SERVER_SCRIPT = `
const readline = require("node:readline");
const mode = process.env.MODE || "normal";
const rl = readline.createInterface({ input: process.stdin });
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");

rl.on("line", (line) => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  if (mode === "silent") return; // Never answers anything.

  if (message.method === "initialize") {
    send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "fake", version: "1" } } });
    return;
  }
  if (message.method === "notifications/initialized") return;
  if (message.method === "tools/list") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        tools: [
          { name: "inspect", description: "Read something", inputSchema: { type: "object", properties: { target: { type: "string" } }, required: ["target"] }, annotations: { readOnlyHint: true } },
          { name: "rewrite", description: "Change something", inputSchema: { type: "object", properties: { target: { type: "string" } } } },
          { name: "explode", description: "Always fails", inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true } },
        ],
      },
    });
    return;
  }
  if (message.method === "tools/call") {
    const name = message.params && message.params.name;
    if (name === "explode") {
      send({ jsonrpc: "2.0", id: message.id, result: { isError: true, content: [{ type: "text", text: "argument target is required" }] } });
      return;
    }
    if (name === "rewrite") {
      // A request *to the client* mid-call. It has to be answered or this server
      // would wait forever, which is why the echo below is the assertion.
      send({ jsonrpc: "2.0", id: 900, method: "roots/list" });
      setTimeout(() => {
        send({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: JSON.stringify(message.params.arguments) }] } });
      }, 20);
      return;
    }
    send({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: "inspected " + (message.params.arguments || {}).target }] } });
    return;
  }
  if (message.id !== undefined && message.method) {
    send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "unknown method" } });
  }
});
`;

const serverPath = path.join(scratch, "fake-server.cjs");
await fs.writeFile(serverPath, SERVER_SCRIPT, "utf8");

/** A config file in the shape every agent client reads and every installer writes. */
const sharedConfig = path.join(scratch, "agent-mcp.json");
await fs.writeFile(
  sharedConfig,
  JSON.stringify({
    mcpServers: {
      fake: { command: process.execPath, args: [serverPath], env: { MODE: "normal" } },
      silent: { command: process.execPath, args: [serverPath], env: { MODE: "silent" } },
      remote: { url: "https://example.invalid/mcp" },
    },
  }),
  "utf8",
);

process.env.MCP_SERVERS = "";
process.env.MCP_CONFIG_PATHS = sharedConfig;
process.env.MCP_STARTUP_TIMEOUT_MS = "3000";
process.env.MCP_TOOL_TIMEOUT_MS = "3000";

const {
  bridgeName,
  parseBridgeName,
  primeMcpTools,
  mcpToolSnapshot,
  mcpServerNames,
  resetMcpBridge,
} = await import("../mcp-tools.js");
const { resolveMcpServers, parseServersSetting } = await import("../mcp-config.js");
const { McpPool } = await import("../mcp.js");

/** How a host calls a bridged tool: by name, with JSON arguments. */
async function runTool(name: string, rawArguments: string): Promise<{ ok: boolean; content: string }> {
  const tool = mcpToolSnapshot().find((candidate) => candidate.name === name);
  if (tool === undefined) return { ok: false, content: `Unknown tool "${name}"` };
  try {
    return await tool.run(JSON.parse(rawArguments) as Record<string, unknown>);
  } catch (error) {
    return { ok: false, content: (error as Error).message };
  }
}

/** And how it asks whether the call needs approval first. */
async function previewTool(name: string, rawArguments: string): Promise<{ summary: string } | null> {
  const tool = mcpToolSnapshot().find((candidate) => candidate.name === name);
  if (tool?.inspect === undefined) return null;
  return tool.inspect(JSON.parse(rawArguments) as Record<string, unknown>);
}

test.after(() => {
  resetMcpBridge();
});

test("servers come from the setting and from the agent config files", () => {
  const resolved = resolveMcpServers(
    JSON.stringify([{ name: "from-env", command: "node", args: ["-e", "0"] }]),
    [sharedConfig],
  );
  assert.deepEqual(
    resolved.servers.map((server) => server.name),
    ["from-env", "fake", "silent"],
  );
  // A URL server cannot be started by a stdio bridge, and saying so beats a server
  // that silently offers no tools.
  assert.ok(resolved.problems.some((problem) => problem.includes('"remote"') && problem.includes("stdio")));
});

test("a malformed setting is reported, not thrown, and the files still load", () => {
  const resolved = resolveMcpServers("{not json", [sharedConfig]);
  assert.equal(resolved.servers.some((server) => server.name === "fake"), true);
  assert.ok(resolved.problems.some((problem) => problem.includes("MCP_SERVERS")));

  const object = parseServersSetting('{"mcpServers":{"x":{"command":"node"}}}', []);
  assert.deepEqual(object.map((server) => server.name), ["x"]);
});

test("tools are named by server and tool, and the name parses back", () => {
  assert.equal(bridgeName("rea", "analyze"), "mcp__rea__analyze");
  assert.deepEqual(parseBridgeName("mcp__rea__analyze"), { server: "rea", tool: "analyze" });
  // A tool name may itself contain the separator; the server name may not.
  assert.deepEqual(parseBridgeName("mcp__rea__decompile__item"), { server: "rea", tool: "decompile__item" });
  assert.equal(parseBridgeName("search_code"), null);
  assert.equal(parseBridgeName("mcp__rea"), null);
});

test("discovery lists what answers, and a silent server does not stop the rest", async () => {
  await primeMcpTools();
  const names = mcpToolSnapshot().map((tool) => tool.name);
  assert.ok(names.includes("mcp__fake__inspect"));
  assert.ok(names.includes("mcp__fake__rewrite"));
  assert.equal(names.includes("mcp__silent__anything"), false);
  assert.deepEqual(mcpServerNames().sort(), ["fake", "silent"]);
});

test("a declared read-only tool runs without approval, an undeclared one asks first", async () => {
  await primeMcpTools();
  const readOnly = mcpToolSnapshot().find((tool) => tool.name === "mcp__fake__inspect");
  const mutating = mcpToolSnapshot().find((tool) => tool.name === "mcp__fake__rewrite");
  assert.ok(readOnly !== undefined && mutating !== undefined);

  // The bridge only attaches `inspect` to tools the server did *not* mark
  // read-only, so its absence is the assertion.
  assert.equal(readOnly.inspect, undefined);
  assert.ok(mutating.inspect !== undefined, "an unannotated tool must ask first");

  const preview = await previewTool("mcp__fake__rewrite", JSON.stringify({ target: "app.exe" }));
  assert.ok(preview !== null && preview.summary.includes("rewrite"));
  assert.equal(await previewTool("mcp__fake__inspect", JSON.stringify({ target: "app.exe" })), null);
});

test("a call returns the server's text, and its failure is a failure", async () => {
  const ok = await runTool("mcp__fake__inspect", JSON.stringify({ target: "libc.so" }));
  assert.equal(ok.ok, true);
  assert.equal(ok.content, "inspected libc.so");

  const failed = await runTool("mcp__fake__explode", "{}");
  assert.equal(failed.ok, false);
  assert.match(failed.content, /target is required/);
});

test("a request from the server mid-call is answered, so the call still completes", async () => {
  const outcome = await runTool("mcp__fake__rewrite", JSON.stringify({ target: "app.exe" }));
  assert.equal(outcome.ok, true);
  assert.deepEqual(JSON.parse(outcome.content), { target: "app.exe" });
});

test("the server's own schema reaches the host unchanged, including required arguments", async () => {
  await primeMcpTools();
  const tool = mcpToolSnapshot().find((entry) => entry.name === "mcp__fake__inspect");
  assert.ok(tool !== undefined);
  assert.deepEqual(tool.parameters.required, ["target"]);
  assert.equal(tool.parameters.type, "object");
});

test("a server that cannot be reached is reported, and offers no tools", async () => {
  const pool = new McpPool([{ name: "absent", command: "/nonexistent/mcp-server", args: [], env: {} }]);
  try {
    const found = await pool.listAll();
    assert.deepEqual(found.tools, []);
    assert.equal(found.failures.length, 1);
  } finally {
    pool.close();
  }
});
