/**
 * OmniRoute MCP Server — barrel export.
 */
export { createMcpServer, startMcpStdio } from "./server.ts";
export { logToolCall, getRecentAuditEntries, getAuditStats } from "./audit.ts";
export * from "./schemas/index.ts";
