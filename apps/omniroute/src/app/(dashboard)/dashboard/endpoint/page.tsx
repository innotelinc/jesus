"use client";

import { useState, useEffect, useCallback } from "react";
import { SegmentedControl } from "@/shared/components";
import { getMachineId } from "@/shared/utils/machine";
import EndpointPageClient from "./EndpointPageClient";
import McpDashboardPage from "../mcp/page";
import A2ADashboardPage from "../a2a/page";
import ApiEndpointsTab from "./ApiEndpointsTab";
import { useTranslations } from "next-intl";

type ServiceStatus = {
  online: boolean;
  loading: boolean;
};

function ServiceToggle({
  label,
  status,
  onRefresh,
}: {
  label: string;
  status: ServiceStatus;
  onRefresh: () => void;
}) {
  return (
    <div className="flex items-center gap-2 ml-auto">
      <button
        onClick={onRefresh}
        className="flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium transition-all border"
        style={{
          borderColor: status.loading
            ? "var(--color-border)"
            : status.online
              ? "rgba(34,197,94,0.3)"
              : "rgba(239,68,68,0.3)",
          background: status.loading
            ? "transparent"
            : status.online
              ? "rgba(34,197,94,0.1)"
              : "rgba(239,68,68,0.1)",
          color: status.loading
            ? "var(--color-text-muted)"
            : status.online
              ? "rgb(34,197,94)"
              : "rgb(239,68,68)",
        }}
      >
        <span
          className="inline-block w-2 h-2 rounded-full"
          style={{
            background: status.loading
              ? "var(--color-text-muted)"
              : status.online
                ? "rgb(34,197,94)"
                : "rgb(239,68,68)",
            animation: status.online ? "pulse 2s infinite" : "none",
          }}
        />
        {status.loading ? "..." : status.online ? "Online" : "Offline"}
      </button>
    </div>
  );
}

export default function EndpointPage() {
  const [activeTab, setActiveTab] = useState("endpoint-proxy");
  const t = useTranslations("endpoints");

  const [mcpStatus, setMcpStatus] = useState<ServiceStatus>({ online: false, loading: true });
  const [a2aStatus, setA2aStatus] = useState<ServiceStatus>({ online: false, loading: true });

  const refreshMcpStatus = useCallback(async () => {
    setMcpStatus((prev) => ({ ...prev, loading: true }));
    try {
      const res = await fetch("/api/mcp/status");
      if (res.ok) {
        const data = await res.json();
        setMcpStatus({ online: !!data.online, loading: false });
      } else {
        setMcpStatus({ online: false, loading: false });
      }
    } catch {
      setMcpStatus({ online: false, loading: false });
    }
  }, []);

  const refreshA2aStatus = useCallback(async () => {
    setA2aStatus((prev) => ({ ...prev, loading: true }));
    try {
      const res = await fetch("/api/a2a/status");
      if (res.ok) {
        const data = await res.json();
        setA2aStatus({ online: data.status === "ok", loading: false });
      } else {
        setA2aStatus({ online: false, loading: false });
      }
    } catch {
      setA2aStatus({ online: false, loading: false });
    }
  }, []);

  useEffect(() => {
    const load = () => {
      void refreshMcpStatus();
      void refreshA2aStatus();
    };
    load();
    const interval = setInterval(load, 30000);
    return () => clearInterval(interval);
  }, [refreshMcpStatus, refreshA2aStatus]);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center gap-3">
        <SegmentedControl
          options={[
            { value: "endpoint-proxy", label: t("tabProxy"), icon: "api" },
            { value: "mcp", label: "MCP", icon: "hub" },
            { value: "a2a", label: "A2A", icon: "group_work" },
            { value: "api-endpoints", label: t("tabApiEndpoints"), icon: "code" },
          ]}
          value={activeTab}
          onChange={setActiveTab}
        />

        {activeTab === "mcp" && (
          <ServiceToggle label="MCP" status={mcpStatus} onRefresh={refreshMcpStatus} />
        )}
        {activeTab === "a2a" && (
          <ServiceToggle label="A2A" status={a2aStatus} onRefresh={refreshA2aStatus} />
        )}
      </div>

      {activeTab === "endpoint-proxy" && <EndpointPageClient machineId="" />}
      {activeTab === "mcp" && <McpDashboardPage />}
      {activeTab === "a2a" && <A2ADashboardPage />}
      {activeTab === "api-endpoints" && <ApiEndpointsTab />}
    </div>
  );
}
