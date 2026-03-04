/**
 * MCP Audit Logger — Records all MCP tool invocations for security and observability.
 *
 * Logs are written to the `mcp_tool_audit` SQLite table.
 * Input data is hashed (SHA-256) to avoid storing sensitive prompts.
 * Output is truncated to 200 chars for summary.
 */

import { hashInput, summarizeOutput } from "./schemas/audit.ts";

// ============ Database Connection ============

interface StatementLike<TRow = unknown> {
  get: (...params: unknown[]) => TRow | undefined;
  all: (...params: unknown[]) => TRow[];
  run: (...params: unknown[]) => unknown;
}

interface AuditDatabase {
  prepare: <TRow = unknown>(sql: string) => StatementLike<TRow>;
}

interface AuditStatsRow {
  total: unknown;
  successRate: unknown;
  avgDuration: unknown;
}

interface AuditTopToolRow {
  tool: unknown;
  count: unknown;
}

let db: AuditDatabase | null = null;

function toNumber(value: unknown, fallback = 0): number {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim().length > 0
        ? Number(value)
        : Number.NaN;
  return Number.isFinite(parsed) ? parsed : fallback;
}

function toString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * Lazy-load the database connection.
 * Uses the same SQLite database as the main OmniRoute app.
 */
async function getDb(): Promise<AuditDatabase | null> {
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

    const Database = (await import("better-sqlite3")).default as unknown as new (
      dbPath: string
    ) => AuditDatabase;
    db = new Database(dbPath);
    return db;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[MCP Audit] Failed to connect to database:", message);
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
  } catch (err: unknown) {
    // Never let audit failure break tool execution
    const message = err instanceof Error ? err.message : String(err);
    console.error("[MCP Audit] Failed to log:", message);
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
      .get() as AuditStatsRow | undefined;

    const topTools = database
      .prepare(
        `SELECT tool_name as tool, COUNT(*) as count
         FROM mcp_tool_audit
         WHERE created_at > datetime('now', '-24 hours')
         GROUP BY tool_name
         ORDER BY count DESC
         LIMIT 10`
      )
      .all() as AuditTopToolRow[];

    return {
      totalCalls: toNumber(stats?.total, 0),
      successRate: toNumber(stats?.successRate, 0),
      avgDurationMs: toNumber(stats?.avgDuration, 0),
      topTools: (topTools || []).map((entry) => ({
        tool: toString(entry.tool),
        count: toNumber(entry.count, 0),
      })),
    };
  } catch {
    return { totalCalls: 0, successRate: 0, avgDurationMs: 0, topTools: [] };
  }
}
