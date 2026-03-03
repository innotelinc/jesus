/**
 * MCP Audit Logger — Records all MCP tool invocations for security and observability.
 *
 * Logs are written to the `mcp_tool_audit` SQLite table.
 * Input data is hashed (SHA-256) to avoid storing sensitive prompts.
 * Output is truncated to 200 chars for summary.
 */

import { hashInput, summarizeOutput } from "./schemas/audit.ts";

// ============ Database Connection ============

let db: any = null;

/**
 * Lazy-load the database connection.
 * Uses the same SQLite database as the main OmniRoute app.
 */
async function getDb(): Promise<any> {
  if (db) return db;

  try {
    // Try importing the db module from the main app
    const { homedir } = await import("node:os");
    const { join } = await import("node:path");
    const { existsSync } = await import("node:fs");

    const dbPath = process.env.DATA_DIR
      ? join(process.env.DATA_DIR, "storage.sqlite")
      : join(homedir(), ".omniroute", "storage.sqlite");

    if (!existsSync(dbPath)) {
      console.error(`[MCP Audit] Database not found at ${dbPath} — audit logging disabled`);
      return null;
    }

    const Database = (await import("better-sqlite3")).default;
    db = new Database(dbPath);
    return db;
  } catch (err) {
    console.error("[MCP Audit] Failed to connect to database:", err);
    return null;
  }
}

// ============ Audit Logger ============

/**
 * Log a tool invocation to the mcp_tool_audit table.
 *
 * Security: Input is hashed, never stored in clear text.
 * Output is truncated to a summary.
 */
export async function logToolCall(
  toolName: string,
  input: unknown,
  output: unknown,
  durationMs: number,
  success: boolean,
  errorCode?: string
): Promise<void> {
  try {
    const database = await getDb();
    if (!database) return; // Audit disabled if no DB

    const inputHash = await hashInput(input);
    const outputSummary = summarizeOutput(output);
    const apiKeyId = process.env.OMNIROUTE_API_KEY_ID || null;

    database
      .prepare(
        `INSERT INTO mcp_tool_audit (tool_name, input_hash, output_summary, duration_ms, api_key_id, success, error_code)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        toolName,
        inputHash,
        outputSummary,
        durationMs,
        apiKeyId,
        success ? 1 : 0,
        errorCode || null
      );
  } catch (err) {
    // Never let audit failure break tool execution
    console.error("[MCP Audit] Failed to log:", err);
  }
}

/**
 * Get recent audit entries (for dashboard/monitoring).
 */
export async function getRecentAuditEntries(limit = 50): Promise<unknown[]> {
  try {
    const database = await getDb();
    if (!database) return [];

    return database
      .prepare("SELECT * FROM mcp_tool_audit ORDER BY created_at DESC LIMIT ?")
      .all(limit);
  } catch {
    return [];
  }
}

/**
 * Get audit stats for monitoring.
 */
export async function getAuditStats(): Promise<{
  totalCalls: number;
  successRate: number;
  avgDurationMs: number;
  topTools: Array<{ tool: string; count: number }>;
}> {
  try {
    const database = await getDb();
    if (!database) return { totalCalls: 0, successRate: 0, avgDurationMs: 0, topTools: [] };

    const stats = database
      .prepare(
        `SELECT 
           COUNT(*) as total,
           AVG(CASE WHEN success = 1 THEN 1.0 ELSE 0.0 END) as successRate,
           AVG(duration_ms) as avgDuration
         FROM mcp_tool_audit
         WHERE created_at > datetime('now', '-24 hours')`
      )
      .get() as any;

    const topTools = database
      .prepare(
        `SELECT tool_name as tool, COUNT(*) as count
         FROM mcp_tool_audit
         WHERE created_at > datetime('now', '-24 hours')
         GROUP BY tool_name
         ORDER BY count DESC
         LIMIT 10`
      )
      .all() as any[];

    return {
      totalCalls: stats?.total || 0,
      successRate: stats?.successRate || 0,
      avgDurationMs: stats?.avgDuration || 0,
      topTools: topTools || [],
    };
  } catch {
    return { totalCalls: 0, successRate: 0, avgDurationMs: 0, topTools: [] };
  }
}
