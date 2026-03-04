/**
 * Dashboard A2A Panel — /dashboard/a2a
 *
 * Shows Agent Card, active/completed tasks, and routing metadata.
 */

"use client";

import { useEffect, useState, useCallback } from "react";

export default function A2ADashboard() {
  const [agentCard, setAgentCard] = useState<any>(null);
  const [tasks, setTasks] = useState<any[]>([]);

  const fetchData = useCallback(async () => {
    try {
      const [cardRes, tasksRes] = await Promise.allSettled([
        fetch("/.well-known/agent.json"),
        fetch("/api/a2a/tasks"),
      ]);
      if (cardRes.status === "fulfilled") setAgentCard(await cardRes.value.json());
      if (tasksRes.status === "fulfilled") {
        const data = await tasksRes.value.json();
        setTasks(Array.isArray(data) ? data : data.tasks || []);
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

  return (
    <div className="p-6 max-w-7xl mx-auto">
      <h1 className="text-2xl font-bold mb-6">🤖 A2A Server Dashboard</h1>

      {/* Agent Card */}
      {agentCard && (
        <div className="mb-8 p-4 bg-white dark:bg-gray-800 rounded-lg shadow border">
          <h2 className="text-lg font-semibold mb-2">{agentCard.name}</h2>
          <p className="text-sm text-gray-500 mb-3">{agentCard.description}</p>
          <div className="flex gap-2 mb-3">
            <span className="px-2 py-1 bg-blue-100 dark:bg-blue-900/30 rounded text-xs">
              v{agentCard.version}
            </span>
            {agentCard.capabilities?.streaming && (
              <span className="px-2 py-1 bg-green-100 dark:bg-green-900/30 rounded text-xs">
                Streaming
              </span>
            )}
          </div>
          <h3 className="font-medium text-sm mb-2">Skills ({agentCard.skills?.length || 0})</h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
            {agentCard.skills?.map((s: any) => (
              <div key={s.id} className="p-2 bg-gray-50 dark:bg-gray-700 rounded text-sm">
                <span className="font-medium">{s.name}</span>
                <p className="text-xs text-gray-500 mt-1">{s.description?.slice(0, 100)}</p>
                <div className="flex gap-1 mt-1">
                  {s.tags?.slice(0, 4).map((t: string) => (
                    <span key={t} className="px-1 bg-gray-200 dark:bg-gray-600 rounded text-xs">
                      {t}
                    </span>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Tasks */}
      <div>
        <h2 className="text-lg font-semibold mb-3">📋 Task History</h2>
        {tasks.length === 0 ? (
          <p className="text-gray-500">
            No A2A tasks yet. Send a request to <code>/a2a</code> to get started.
          </p>
        ) : (
          <div className="space-y-2">
            {tasks.map((task: any) => (
              <div key={task.id} className="p-3 bg-white dark:bg-gray-800 rounded border">
                <div className="flex justify-between items-center">
                  <span className="font-mono text-xs">{task.id}</span>
                  <span
                    className={`px-2 py-0.5 rounded text-xs ${
                      task.state === "completed"
                        ? "bg-green-100 text-green-700"
                        : task.state === "failed"
                          ? "bg-red-100 text-red-700"
                          : task.state === "working"
                            ? "bg-yellow-100 text-yellow-700"
                            : "bg-gray-100 text-gray-700"
                    }`}
                  >
                    {task.state}
                  </span>
                </div>
                <p className="text-sm mt-1">
                  Skill: <strong>{task.skill}</strong>
                </p>
                {task.metadata?.routing_explanation && (
                  <p className="text-xs text-gray-500 mt-1">{task.metadata.routing_explanation}</p>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
