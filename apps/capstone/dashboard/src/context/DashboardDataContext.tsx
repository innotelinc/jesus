import {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  useMemo,
  useRef,
  type ReactNode,
} from 'react';
import type {
  Service,
  Port,
  Secret,
  Alert,
  User,
  ResourceLink,
  HealthMatrixEntry,
  Incident,
  ConfigPolicy,
  AuditEntry,
  DashboardStats,
} from '../types';
import {
  services as sampleServices,
  ports as samplePorts,
  secrets as sampleSecrets,
  alerts as sampleAlerts,
  users as sampleUsers,
  links as sampleLinks,
  healthData as sampleHealth,
  incidents as sampleIncidents,
  policies as samplePolicies,
  auditLog as sampleAudit,
  dashboardStats as sampleStats,
} from '../lib/data';
import { api } from '../lib/api';

export type DataState = 'loading' | 'live' | 'error';

// How often the dashboard re-fetches the whole payload in the background so
// services, alerts, and KPIs stay live without a manual refresh.
const POLL_INTERVAL_MS = 30_000;

export interface DashboardData {
  services: Service[];
  ports: Port[];
  secrets: Secret[];
  alerts: Alert[];
  users: User[];
  links: ResourceLink[];
  healthData: HealthMatrixEntry[];
  incidents: Incident[];
  policies: ConfigPolicy[];
  auditLog: AuditEntry[];
  dashboardStats: DashboardStats;
  state: DataState;
  lastRefreshed: string | null;
  refresh: () => Promise<void>;
}

const DashboardDataContext = createContext<DashboardData | undefined>(undefined);

export function DashboardDataProvider({ children }: { children: ReactNode }) {
  const [payload, setPayload] = useState({
    services: sampleServices,
    ports: samplePorts,
    secrets: sampleSecrets,
    alerts: sampleAlerts,
    users: sampleUsers,
    links: sampleLinks,
    healthData: sampleHealth,
    incidents: sampleIncidents,
    policies: samplePolicies,
    auditLog: sampleAudit,
    dashboardStats: sampleStats,
  });
  const [state, setState] = useState<DataState>('loading');
  const [lastRefreshed, setLastRefreshed] = useState<string | null>(null);
  const mountedRef = useRef(true);
  // First load may show a spinner; background polls must not blank the UI.
  const hasLoadedRef = useRef(false);

  const fetchAll = useCallback(async () => {
    if (!hasLoadedRef.current) {
      setState('loading');
    }
    try {
      const [services, ports, secrets, alerts, users, links, healthData, incidents, policies, auditLog, stats] =
        await Promise.all([
          api.services(),
          api.ports(),
          api.secrets(),
          api.alerts(),
          api.users(),
          api.links(),
          api.health(),
          api.incidents(),
          api.policies(),
          api.audit(),
          api.stats(),
        ]);
      if (!mountedRef.current) return;
      setPayload({ services, ports, secrets, alerts, users, links, healthData, incidents, policies, auditLog, dashboardStats: stats });
      setLastRefreshed(new Date().toISOString());
      setState('live');
      hasLoadedRef.current = true;
    } catch {
      if (mountedRef.current) {
        // Keep the previous payload (sample data on first load) so a backend
        // outage never blanks the UI.
        setState('error');
      }
    }
  }, []);

  const refresh = useCallback(async () => {
    await fetchAll();
  }, [fetchAll]);

  useEffect(() => {
    mountedRef.current = true;
    void fetchAll();
    const timer = setInterval(() => {
      if (mountedRef.current) {
        void fetchAll();
      }
    }, POLL_INTERVAL_MS);
    return () => {
      mountedRef.current = false;
      clearInterval(timer);
    };
  }, [fetchAll]);

  const value = useMemo<DashboardData>(
    () => ({ ...payload, state, lastRefreshed, refresh }),
    [payload, state, lastRefreshed, refresh],
  );

  return (
    <DashboardDataContext.Provider value={value}>
      {children}
    </DashboardDataContext.Provider>
  );
}

export function useDashboardData() {
  const ctx = useContext(DashboardDataContext);
  if (!ctx) throw new Error('useDashboardData must be used within DashboardDataProvider');
  return ctx;
}