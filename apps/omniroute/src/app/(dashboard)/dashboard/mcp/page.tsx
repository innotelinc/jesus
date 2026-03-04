/**
 * Dashboard MCP Panel — /dashboard/mcp
 *
 * Shows MCP tool audit log, usage stats, and real-time metrics.
 */

"use client";

import { useEffect, useState, useCallback } from "react";

interface AuditEntry {
  tool_name: string;
  timestamp: string;
  duration_ms: number;
  success: boolean;
  api_key_hash: string;
}

interface McpStats {
  totalCalls: number;
  successRate: number;
  avgDurationMs: number;
  byTool: Array<{ tool: string; count: number; avgMs: number }>;
}

export default function McpDashboard() {
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [stats, setStats] = useState<McpStats | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchData = useCallback(async () => {
    try {
      const [auditRes, statsRes] = await Promise.allSettled([
        fetch("/api/mcp/audit?limit=50"),
        fetch("/api/mcp/audit/stats"),
      ]);
      if (auditRes.status === "fulfilled") setAudit(await auditRes.value.json());
      if (statsRes.status === "fulfilled") setStats(await statsRes.value.json());
    } catch {
      /* fallback data */
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    const id = setTimeout(fetchData, 0);
    const interval = setInterval(fetchData, 30_000);
    return () => {
      clearTimeout(id);
      clearInterval(interval);
    };
  }, [fetchData]);

  const tools = [
    "omniroute_get_health",
    "omniroute_list_combos",
    "omniroute_get_combo_metrics",
    "omniroute_switch_combo",
    "omniroute_check_quota",
    "omniroute_route_request",
    "omniroute_cost_report",
    "omniroute_list_models_catalog",
    "omniroute_simulate_route",
    "omniroute_set_budget_guard",
    "omniroute_set_resilience_profile",
    "omniroute_test_combo",
    "omniroute_get_provider_metrics",
    "omniroute_best_combo_for_task",
    "omniroute_explain_route",
    "omniroute_get_session_snapshot",
  ];

  return (
    <div className="p-6 max-w-7xl mx-auto">
      <h1 className="text-2xl font-bold mb-6">🔧 MCP Server Dashboard</h1>

      {/* Stats Grid */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-8">
        <StatCard label="Total Calls" value={stats?.totalCalls || 0} />
        <StatCard label="Success Rate" value={`${((stats?.successRate || 1) * 100).toFixed(1)}%`} />
        <StatCard label="Avg Latency" value={`${stats?.avgDurationMs || 0}ms`} />
        <StatCard label="Active Tools" value={tools.length} />
      </div>

      {/* Tool List */}
      <div className="mb-8">
        <h2 className="text-lg font-semibold mb-3">📋 Available Tools ({tools.length})</h2>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
          {tools.map((t) => (
            <div
              key={t}
              className="p-2 bg-green-50 dark:bg-green-900/20 rounded text-sm border border-green-200 dark:border-green-800"
            >
              <span className="text-green-600 mr-1">●</span> {t.replace("omniroute_", "")}
            </div>
          ))}
        </div>
      </div>

      {/* Audit Log */}
      <div>
        <h2 className="text-lg font-semibold mb-3">📊 Recent Calls</h2>
        {loading ? (
          <p className="text-gray-500">Loading...</p>
        ) : audit.length === 0 ? (
          <p className="text-gray-500">
            No MCP calls yet. Use <code>omniroute --mcp</code> to connect.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b">
                  <th className="text-left p-2">Tool</th>
                  <th className="text-left p-2">Time</th>
                  <th className="text-left p-2">Duration</th>
                  <th className="text-left p-2">Status</th>
                </tr>
              </thead>
              <tbody>
                {audit.map((entry, i) => (
                  <tr key={i} className="border-b hover:bg-gray-50 dark:hover:bg-gray-800">
                    <td className="p-2 font-mono text-xs">{entry.tool_name}</td>
                    <td className="p-2 text-xs">
                      {new Date(entry.timestamp).toLocaleTimeString()}
                    </td>
                    <td className="p-2">{entry.duration_ms}ms</td>
                    <td className="p-2">{entry.success ? "✅" : "❌"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

function StatCard({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="p-4 bg-white dark:bg-gray-800 rounded-lg shadow border">
      <p className="text-sm text-gray-500 dark:text-gray-400">{label}</p>
      <p className="text-2xl font-bold mt-1">{value}</p>
    </div>
  );
}
