/**
 * Settings, read once from the environment.
 *
 * Same names the host console uses, so a deployment that already sets them for
 * Genie needs nothing new. Read at import time, like every other config in this
 * ecosystem: a value that changes mid-process would be a surprise, not a feature.
 */

/** One MCP server this process can start. */
export interface McpServerConfig {
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
}

function env(name: string): string {
  return (process.env[name] ?? "").trim();
}

function envInt(name: string, fallback: number): number {
  const raw = env(name);
  if (raw === "") return fallback;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function envList(name: string, fallback: string[]): string[] {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
}

const DATA_DIR = env("AGENT_DATA_DIR") || "./.agent";

export const config = {
  /**
   * Servers, as a JSON array or an `{"mcpServers": {…}}` object.
   *
   * Spawned directly, never through a shell: this is data, and data that reached a
   * shell would be command injection with a friendly name.
   */
  mcpServers: env("MCP_SERVERS"),
  /**
   * Agent config files to read servers from, in order.
   *
   * `/root/.agents/mcp.json` is where the agent ecosystem's installers write their
   * registrations — a tool's own `setup` therefore registers with this bridge too.
   */
  mcpConfigPaths: envList("MCP_CONFIG_PATHS", [
    "/root/.agents/mcp.json",
    `${DATA_DIR}/mcp.json`,
  ]),
  /** How long a server has to answer its handshake and tool listing. */
  mcpStartupTimeoutMs: envInt("MCP_STARTUP_TIMEOUT_MS", 20_000),
  /** How long one delegated tool call may take. */
  mcpToolTimeoutMs: envInt("MCP_TOOL_TIMEOUT_MS", 300_000),
};
