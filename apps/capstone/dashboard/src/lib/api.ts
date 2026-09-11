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
  Entitlement,
} from '../types';
import { dashboardBaseUrl } from './config';
import type { Verdict } from './utils';

async function getJSON<T>(path: string): Promise<T> {
  const response = await fetch(`${dashboardBaseUrl}${path}`, {
    method: 'GET',
    headers: { Accept: 'application/json' },
  });
  if (response.status === 401) {
    // Cerulean gate: no (or expired) session → send the user through the
    // Authentik login flow, then back to the page they were on.
    window.location.href = `${dashboardBaseUrl}/auth/login?next=${encodeURIComponent(window.location.pathname)}`;
    throw new Error('Session required');
  }
  if (!response.ok) {
    throw new Error(`Dashboard API ${path} failed: ${response.status}`);
  }
  return (await response.json()) as T;
}

async function sendJSON<T>(path: string, method: 'POST' | 'PUT' | 'DELETE'): Promise<T> {
  const response = await fetch(`${dashboardBaseUrl}${path}`, {
    method,
    headers: { Accept: 'application/json' },
  });
  if (response.status === 401) {
    window.location.href = `${dashboardBaseUrl}/auth/login?next=${encodeURIComponent(window.location.pathname)}`;
    throw new Error('Session required');
  }
  if (!response.ok) {
    const detail = await response.json().catch(() => null);
    throw new Error(detail?.detail || `Dashboard API ${path} failed: ${response.status}`);
  }
  return (await response.json()) as T;
}

async function postJSON<T>(path: string, body: unknown, method = 'POST'): Promise<T> {
  const response = await fetch(`${dashboardBaseUrl}${path}`, {
    method,
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (response.status === 401) {
    window.location.href = `${dashboardBaseUrl}/auth/login?next=${encodeURIComponent(window.location.pathname)}`;
    throw new Error('Session required');
  }
  if (!response.ok) {
    const detail = await response.json().catch(() => null);
    throw new Error(detail?.detail || `Dashboard API ${path} failed: ${response.status}`);
  }
  return (await response.json()) as T;
}

async function deleteJSON<T>(path: string): Promise<T> {
  return sendJSON<T>(path, 'DELETE');
}

export interface ServiceLogs {
  service: string;
  lines: string[];
}

export interface PbxExtension {
  extension: string;
  callerId: string;
  hasPassword: true;
  authUser: string;
  registered?: boolean;
  contactUri?: string | null;
  builtIn?: boolean;
  dids?: string[];
}

export interface PbxExtensionUpdate {
  callerId?: string;
  password?: string;
  dids?: string[];
}

export interface ExtensionCall {
  time: string;
  src: string;
  dst: string;
  direction: 'in' | 'out';
  peer: string;
  disposition: string;
  durationSeconds: number;
  billableSeconds: number;
  viaChannel: string;
}

export interface PbxExtensionCreate {
  extension: string;
  password: string;
  callerId?: string;
  dids?: string[];
}

export interface Agent {
  id: number;
  extension: string;
  address: string;
  label: string;
  workflowId?: number | null;
  workflowName?: string;
  active: boolean;
  pbx?: {
    status: 'provisioned' | 'partial' | 'not-provisioned' | 'pending-sync' | 'error';
    customExtension?: boolean | null;
    inboundRoute?: boolean | null;
    dialplan?: boolean | null;
    detail?: string | null;
  };
}

export interface AgentWorkflow {
  id: number;
  name: string;
}

export interface AgentsResponse {
  mode: 'standalone' | 'addon';
  configured: boolean;
  agents: Agent[];
  error?: string;
}

export interface AgentCreate {
  address: string;
  label: string;
  workflowId?: number | null;
}

export interface AgentUpdate {
  label?: string;
  workflowId?: number | null;
  active?: boolean;
}

export interface DimensionScore {
  name: string;
  score: number | null;
  evidence: string;
}

export interface InterviewReport {
  id: number;
  track: string;
  trackLabel: string;
  student: string;
  phone: string;
  runId: string;
  score: number | null;
  verdict: Verdict;
  dimensions: DimensionScore[];
  strengths: string[];
  improvements: string[];
  transcript: string;
  parseError: string;
}

export interface InterviewReportsResponse {
  configured: boolean;
  docId: string;
  reports: InterviewReport[];
  error?: string;
}

export interface Me {
  authenticated: boolean;
  name: string | null;
  email: string | null;
}

export const api = {
  me: () => getJSON<Me>('/auth/me'),
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
  entitlements: () => getJSON<Entitlement>('/entitlements'),
  serviceLogs: (id: string, tail = 200) =>
    getJSON<ServiceLogs>(`/services/${encodeURIComponent(id)}/logs?tail=${tail}`),
  restartService: (id: string) => sendJSON<{ status: string; service: string }>(`/services/${encodeURIComponent(id)}/restart`, 'POST'),
  extensions: () => getJSON<PbxExtension[]>('/extensions'),
  createExtension: (body: PbxExtensionCreate) =>
    postJSON<{ status: string; extension: string }>('/extensions', body),
  updateExtension: (ext: string, body: PbxExtensionUpdate) =>
    postJSON<{ status: string; extension: string }>(`/extensions/${encodeURIComponent(ext)}`, body, 'PATCH'),
  deleteExtension: (ext: string) =>
    deleteJSON<{ status: string; extension: string }>(`/extensions/${encodeURIComponent(ext)}`),
  rotateExtensionPassword: (ext: string, password: string) =>
    postJSON<{ status: string; extension: string }>(`/extensions/${encodeURIComponent(ext)}/password`, { password }),
  extensionCalls: (ext: string) =>
    getJSON<ExtensionCall[]>(`/extensions/${encodeURIComponent(ext)}/calls`),
  agents: () => getJSON<AgentsResponse>('/agents'),
  agentWorkflows: () => getJSON<AgentWorkflow[]>('/agents/workflows'),
  createAgent: (body: AgentCreate) =>
    postJSON<{ agent: Agent; mode: string; warnings: string[] }>('/agents', body),
  updateAgent: (id: number, body: AgentUpdate) =>
    postJSON<{ agent: Agent; mode: string; warnings: string[] }>(`/agents/${id}`, body, 'PUT'),
  deleteAgent: (id: number) =>
    deleteJSON<{ status: string; id: number; warnings: string[] }>(`/agents/${id}`),
  interviewReports: () => getJSON<InterviewReportsResponse>('/interviews/reports'),
};

/**
 * Indicates whether the aggregator is configured at all. When it isn't
 * (local development without a backend), consumers transparently fall back to
 * sample data instead of flashing errors.
 */
export function isBackendConfigured(): boolean {
  return dashboardBaseUrl.trim().length > 0;
}