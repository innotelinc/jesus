'use client';

import { useEffect, useState } from 'react';
import { Server, AlertTriangle, Clock, Globe } from 'lucide-react';
import type { AuditEntry } from '@/lib/admin/types';

interface AdminStatus {
  enabled: boolean;
  authenticated: boolean;
  lastLogin: string | null;
  passwordChangedAt: string | null;
}

interface ConfigData {
  appName?: string;
  jmapServerUrl?: string;
  settingsSyncEnabled?: boolean;
  stalwartFeaturesEnabled?: boolean;
  oauthEnabled?: boolean;
  devMode?: boolean;
}

export default function AdminDashboardPage() {
  const [status, setStatus] = useState<AdminStatus | null>(null);
  const [recentActivity, setRecentActivity] = useState<AuditEntry[]>([]);
  const [config, setConfig] = useState<ConfigData | null>(null);
  const [, setConfigSources] = useState<Record<string, { value: unknown; source: string }> | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);

  useEffect(() => {
    fetchDashboardData();
  }, []);

  async function fetchDashboardData() {
    const [statusRes, auditRes, configRes, adminConfigRes] = await Promise.all([
      fetch('/api/admin/auth'),
      fetch('/api/admin/audit?limit=10'),
      fetch('/api/config'),
      fetch('/api/admin/config'),
    ]);

    if (statusRes.ok) setStatus(await statusRes.json());
    if (auditRes.ok) {
      const data = await auditRes.json();
      setRecentActivity(data.entries || []);
    }
    if (configRes.ok) setConfig(await configRes.json());

    // Build warnings
    const w: string[] = [];
    if (adminConfigRes.ok) {
      const sources = await adminConfigRes.json();
      setConfigSources(sources);
      const sessionSecret = sources?.sessionSecret;
      if (!sessionSecret?.value || sessionSecret.value === 'your-secret-key-here') {
        w.push('SESSION_SECRET is not set or using a default value. Sessions are insecure.');
      }
    }
    setWarnings(w);
  }

  const jmapUrl = config?.jmapServerUrl || '—';

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-foreground">Dashboard</h1>
        <p className="text-sm text-muted-foreground mt-1">Server overview and recent activity</p>
      </div>

      {/* Status cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <StatusCard
          icon={<Server className="w-4 h-4" />}
          label="Application"
          value={config?.appName || '—'}
        />
        <StatusCard
          icon={<Globe className="w-4 h-4" />}
          label="JMAP Server"
          value={jmapUrl ? new URL(jmapUrl).hostname : '—'}
          detail={jmapUrl}
        />
        <StatusCard
          icon={<Clock className="w-4 h-4" />}
          label="Last Login"
          value={status?.lastLogin ? new Date(status.lastLogin).toLocaleString() : 'Never'}
        />
      </div>

      {/* Feature status row */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <FeaturePill label="Admin" active={!!status?.enabled} />
        <FeaturePill label="Settings Sync" active={!!config?.settingsSyncEnabled} />
        <FeaturePill label="OAuth" active={!!config?.oauthEnabled} />
        <FeaturePill label="Stalwart" active={config?.stalwartFeaturesEnabled !== false} />
      </div>

      {/* Warnings */}
      {warnings.map((msg, i) => (
        <div key={i} className="flex items-start gap-3 rounded-lg border border-amber-200 bg-amber-50 dark:border-amber-900 dark:bg-amber-950/30 p-4">
          <AlertTriangle className="w-5 h-5 text-amber-600 dark:text-amber-400 mt-0.5 shrink-0" />
          <p className="text-sm text-amber-700 dark:text-amber-300">{msg}</p>
        </div>
      ))}

      {status && !status.lastLogin && (
        <div className="flex items-start gap-3 rounded-lg border border-amber-200 bg-amber-50 dark:border-amber-900 dark:bg-amber-950/30 p-4">
          <AlertTriangle className="w-5 h-5 text-amber-600 dark:text-amber-400 mt-0.5 shrink-0" />
          <div>
            <p className="text-sm font-medium text-amber-800 dark:text-amber-200">First login detected</p>
            <p className="text-sm text-amber-700 dark:text-amber-300 mt-0.5">
              Remember to remove ADMIN_PASSWORD from your .env file now that the hash is stored securely.
            </p>
          </div>
        </div>
      )}

      {/* Recent activity */}
      <div>
        <h2 className="text-lg font-medium text-foreground mb-3">Recent Activity</h2>
        <div className="border border-border rounded-lg divide-y divide-border">
          {recentActivity.length === 0 ? (
            <div className="px-4 py-8 text-center text-sm text-muted-foreground">
              No activity recorded yet
            </div>
          ) : (
            recentActivity.map((entry, i) => (
              <div key={i} className="px-4 py-3 flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <span className="text-xs font-mono px-2 py-0.5 rounded bg-muted text-muted-foreground">
                    {entry.action}
                  </span>
                  <span className="text-sm text-foreground">
                    {formatDetail(entry.detail)}
                  </span>
                </div>
                <div className="flex items-center gap-3 text-xs text-muted-foreground">
                  <span>{entry.ip}</span>
                  <span>{new Date(entry.ts).toLocaleString()}</span>
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

function StatusCard({ icon, label, value, detail }: { icon: React.ReactNode; label: string; value: string; detail?: string }) {
  return (
    <div className="border border-border rounded-lg p-4 bg-secondary/20">
      <div className="flex items-center gap-2 text-muted-foreground mb-2">
        {icon}
        <span className="text-xs font-medium uppercase tracking-wider">{label}</span>
      </div>
      <div className="text-lg font-semibold text-foreground truncate">{value}</div>
      {detail && <p className="text-xs text-muted-foreground mt-1 truncate">{detail}</p>}
    </div>
  );
}

function FeaturePill({ label, active }: { label: string; active: boolean }) {
  return (
    <div className="flex items-center gap-2 border border-border rounded-md px-3 py-2">
      <span className={`w-2 h-2 rounded-full ${active ? 'bg-green-500' : 'bg-muted-foreground/40'}`} />
      <span className="text-xs font-medium text-foreground">{label}</span>
      <span className={`text-xs ml-auto ${active ? 'text-green-600 dark:text-green-400' : 'text-muted-foreground'}`}>
        {active ? 'On' : 'Off'}
      </span>
    </div>
  );
}

function formatDetail(detail: Record<string, unknown>): string {
  if (!detail || Object.keys(detail).length === 0) return '';
  if (detail.key) return `${detail.key}: ${detail.old} → ${detail.new}`;
  if (detail.reason) return String(detail.reason);
  if (detail.changes && Array.isArray(detail.changes)) return `${detail.changes.length} setting(s) changed`;
  return JSON.stringify(detail).slice(0, 80);
}
