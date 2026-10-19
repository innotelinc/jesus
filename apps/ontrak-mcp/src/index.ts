/**
 * A Model Context Protocol client and tool bridge, for any agent console.
 *
 * Three pieces, usable separately:
 *
 *   * `McpPool` / `McpConnection` (`./mcp.js`) — the protocol: a stdio server, its
 *     handshake, its tool list, its calls, and the failure modes in between;
 *   * `resolveMcpServers` (`./mcp-config.js`) — where servers are configured from,
 *     including the agent config files a tool's own installer writes;
 *   * `mcpToolDefinitions` (`./mcp-tools.js`) — the bridge: server tools presented in
 *     the host's `ToolDefinition` shape, with approval decided by the server's own
 *     `readOnlyHint` annotation.
 *
 * No dependencies, and no transport but stdio: the wire contract is four methods
 * wide, and a dependency larger than the protocol is a heavier thing to keep
 * patched than the protocol itself.
 */
export { McpPool, McpError } from "./mcp.js";
export type { McpToolInfo, McpCallResult } from "./mcp.js";
export { resolveMcpServers, parseServersSetting } from "./mcp-config.js";
export type { ResolvedMcpServers } from "./mcp-config.js";
export {
  bridgeName,
  parseBridgeName,
  primeMcpTools,
  mcpToolSnapshot,
  mcpToolDefinitions,
  mcpProblems,
  mcpServerNames,
  refreshMcpTools,
  resetMcpBridge,
} from "./mcp-tools.js";
export type { ToolDefinition, ToolOutcome, ToolPreview } from "./types.js";
export { config } from "./config.js";
export type { McpServerConfig } from "./config.js";
