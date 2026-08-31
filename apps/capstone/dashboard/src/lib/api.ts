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
import { dashboardBaseUrl } from './config';

async function getJSON<T>(path: string): Promise<T> {
  const response = await fetch(`${dashboardBaseUrl}${path}`, {
    method: 'GET',
    headers: { Accept: 'application/json' },
  });
  if (!response.ok) {
    throw new Error(`Dashboard API ${path} failed: ${response.status}`);
  }
  return (await response.json()) as T;
}

export const api = {
  services: () => getJSON<Service[]>('/services'),
  ports: () => getJSON<Port[]>('/ports'),
  secrets: () => getJSON<Secret[]>('/secrets'),
  alerts: () => getJSON<Alert[]>('/alerts'),
  users: () => getJSON<User[]>('/users'),
  links: () => getJSON<ResourceLink[]>('/links'),
  health: () => getJSON<HealthMatrixEntry[]>('/health'),
  incidents: () => getJSON<Incident[]>('/incidents'),
  policies: () => getJSON<ConfigPolicy[]>('/policies'),
  audit: () => getJSON<AuditEntry[]>('/audit'),
  stats: () => getJSON<DashboardStats>('/stats'),
};

/**
 * Indicates whether the aggregator is configured at all. When it isn't
 * (local development without a backend), consumers transparently fall back to
 * sample data instead of flashing errors.
 */
export function isBackendConfigured(): boolean {
  return dashboardBaseUrl.trim().length > 0;
}