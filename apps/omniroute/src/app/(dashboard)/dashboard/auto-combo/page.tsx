/**
 * Dashboard Auto-Combo Panel — /dashboard/auto-combo
 *
 * Shows provider scores, scoring factors, exclusions, mode packs, and routing history.
 */

"use client";

import { useEffect, useState, useCallback } from "react";

interface ProviderScore {
  provider: string;
  model: string;
  score: number;
  factors: Record<string, number>;
}

interface ExclusionEntry {
  provider: string;
  excludedAt: string;
  cooldownMs: number;
  reason: string;
}

export default function AutoComboDashboard() {
  const [scores, setScores] = useState<ProviderScore[]>([]);
  const [exclusions, setExclusions] = useState<ExclusionEntry[]>([]);
  const [incidentMode, setIncidentMode] = useState(false);
  const [modePack, setModePack] = useState("ship-fast");

  const fetchData = useCallback(async () => {
    try {
      const [combosRes, healthRes] = await Promise.allSettled([
        fetch("/api/combos/auto"),
        fetch("/api/monitoring/health"),
      ]);

      if (healthRes.status === "fulfilled") {
        const health = await healthRes.value.json();
        const breakers = health?.circuitBreakers || [];
        const openCount = breakers.filter((b: any) => b.state === "OPEN").length;
        setIncidentMode(openCount / Math.max(breakers.length, 1) > 0.5);
      }
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    const id = setTimeout(fetchData, 0);
    const interval = setInterval(fetchData, 30_000);
    return () => {
      clearTimeout(id);
      clearInterval(interval);
    };
  }, [fetchData]);

  const FACTOR_LABELS: Record<string, string> = {
    quota: "📊 Quota",
    health: "💚 Health",
    costInv: "💰 Cost",
    latencyInv: "⚡ Latency",
    taskFit: "🎯 Task Fit",
    stability: "📈 Stability",
  };

  const MODE_PACKS = [
    { id: "ship-fast", label: "🚀 Ship Fast" },
    { id: "cost-saver", label: "💰 Cost Saver" },
    { id: "quality-first", label: "🎯 Quality First" },
    { id: "offline-friendly", label: "📡 Offline Friendly" },
  ];

  return (
    <div className="p-6 max-w-7xl mx-auto">
      <h1 className="text-2xl font-bold mb-6">⚡ Auto-Combo Engine</h1>

      {/* Status Bar */}
      <div className="flex gap-4 mb-6">
        <div
          className={`px-3 py-2 rounded-lg text-sm font-medium ${incidentMode ? "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300" : "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300"}`}
        >
          {incidentMode ? "🚨 INCIDENT MODE" : "✅ Normal"}
        </div>
        <div className="px-3 py-2 bg-blue-100 dark:bg-blue-900/30 rounded-lg text-sm">
          Mode: <strong>{MODE_PACKS.find((m) => m.id === modePack)?.label || modePack}</strong>
        </div>
      </div>

      {/* Mode Pack Selector */}
      <div className="mb-8">
        <h2 className="text-lg font-semibold mb-3">🎛️ Mode Pack</h2>
        <div className="flex gap-2">
          {MODE_PACKS.map((mp) => (
            <button
              key={mp.id}
              onClick={() => setModePack(mp.id)}
              className={`px-4 py-2 rounded-lg text-sm transition-colors ${
                modePack === mp.id
                  ? "bg-blue-600 text-white"
                  : "bg-gray-100 dark:bg-gray-800 hover:bg-gray-200 dark:hover:bg-gray-700"
              }`}
            >
              {mp.label}
            </button>
          ))}
        </div>
      </div>

      {/* Provider Scores */}
      <div className="mb-8">
        <h2 className="text-lg font-semibold mb-3">📊 Provider Scores</h2>
        {scores.length === 0 ? (
          <p className="text-gray-500">
            No auto-combo configured. Create one via <code>POST /api/combos/auto</code>.
          </p>
        ) : (
          <div className="space-y-3">
            {scores.map((s) => (
              <div key={s.provider} className="p-3 bg-white dark:bg-gray-800 rounded-lg border">
                <div className="flex justify-between items-center mb-2">
                  <span className="font-medium">
                    {s.provider} / {s.model}
                  </span>
                  <span className="font-bold text-lg">{(s.score * 100).toFixed(0)}%</span>
                </div>
                {/* Score Bar */}
                <div className="h-2 bg-gray-200 dark:bg-gray-700 rounded overflow-hidden mb-2">
                  <div
                    className="h-full bg-blue-500 rounded"
                    style={{ width: `${s.score * 100}%` }}
                  />
                </div>
                {/* Factor Breakdown */}
                <div className="grid grid-cols-3 gap-1 text-xs text-gray-500">
                  {Object.entries(s.factors || {}).map(([key, val]) => (
                    <span key={key}>
                      {FACTOR_LABELS[key] || key}: {((val as number) * 100).toFixed(0)}%
                    </span>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Exclusions */}
      <div>
        <h2 className="text-lg font-semibold mb-3">🚫 Excluded Providers</h2>
        {exclusions.length === 0 ? (
          <p className="text-gray-500">No providers currently excluded.</p>
        ) : (
          <div className="space-y-2">
            {exclusions.map((e) => (
              <div
                key={e.provider}
                className="p-3 bg-red-50 dark:bg-red-900/10 rounded border border-red-200 dark:border-red-800"
              >
                <div className="flex justify-between">
                  <span className="font-medium text-red-700 dark:text-red-400">{e.provider}</span>
                  <span className="text-xs text-gray-500">
                    Cooldown: {Math.round(e.cooldownMs / 60000)}min
                  </span>
                </div>
                <p className="text-xs text-gray-500 mt-1">{e.reason}</p>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
