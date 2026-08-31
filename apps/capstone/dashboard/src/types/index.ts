export type Environment = 'dev' | 'test' | 'stage' | 'prod';

export type ServiceStatus = 'healthy' | 'warning' | 'critical' | 'offline';

export type PortProtocol = 'tcp' | 'udp' | 'tls' | 'udp6' | 'tcp6';

export type PortStatus = 'open' | 'filtered' | 'closed' | 'unknown';

export type SecretStatus = 'active' | 'rotated' | 'expired' | 'pending';

export type AlertSeverity = 'critical' | 'warning' | 'info';

export type AlertStatus = 'open' | 'acknowledged' | 'resolved' | 'escalated';

export type Role = 'admin' | 'operator' | 'viewer' | 'auditor';

export interface HealthCheck {
  checkedAt: string;
  latencyMs: number;
  errorRate: number;
  availability: number;
  status: ServiceStatus;
  dependencies: string[];
}

export interface Service {
  id: string;
  name: string;
  description: string;
  version: string;
  status: ServiceStatus;
  healthScore: number;
  cpuUsage: number;
  memoryUsage: number;
  memoryBytes: number;
  trafficBytesPerSec: number;
  lastRestart: string;
  uptimeSeconds: number;
  environment: Environment;
  owner: string;
  tags: string[];
  health: HealthCheck;
}

export interface Port {
  port: number;
  protocol: PortProtocol;
  service: string;
  host: string;
  status: PortStatus;
  environment: Environment;
  owner: string;
  risk: 'low' | 'medium' | 'high' | 'critical';
  lastSeen: string;
  utilization: number;
  tags: string[];
}

export interface Secret {
  id: string;
  name: string;
  environment: Environment;
  owner: string;
  rotatedAt: string;
  expiresAt: string;
  status: SecretStatus;
  permissions: { role: Role; grantedAt: string }[];
  type: 'api-key' | 'password' | 'certificate' | 'token' | 'credential';
}

export interface Alert {
  id: string;
  time: string;
  service: string;
  severity: AlertSeverity;
  message: string;
  status: AlertStatus;
  assignedTo: string;
  tags: string[];
  count?: number;
}

export interface MetricPoint {
  timestamp: string;
  value: number;
}

export interface MonitoringMetrics {
  cpu: MetricPoint[];
  memory: MetricPoint[];
  disk: MetricPoint[];
  networkIn: MetricPoint[];
  networkOut: MetricPoint[];
  requestRate: MetricPoint[];
  errorRate: MetricPoint[];
  activeSessions: MetricPoint[];
}

export interface ResourceSnapshot {
  cpuPercent: number;
  memoryPercent: number;
  memoryBytes: number;
  diskPercent: number;
  diskBytes: number;
  networkIn: number;
  networkOut: number;
  requestRate: number;
  errorRate: number;
  activeSessions: number;
}

export interface User {
  id: string;
  name: string;
  email: string;
  role: Role;
  status: 'active' | 'disabled' | 'pending';
  lastActive: string;
  createdAt: string;
  sessions: number;
}

export interface ConfigPolicy {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  value: string;
  updatedAt: string;
}

export interface AuditEntry {
  id: string;
  timestamp: string;
  actor: string;
  action: string;
  resource: string;
  details: string;
  ip: string;
}

export interface ResourceLink {
  id: string;
  name: string;
  description: string;
  url: string;
  category: 'services' | 'documentation' | 'monitoring' | 'repositories' | 'external' | 'support';
  status: 'verified' | 'degraded' | 'unknown';
  lastVerified: string;
}

export interface DashboardStats {
  totalServices: number;
  healthyServices: number;
  warningServices: number;
  criticalServices: number;
  activePorts: number;
  openAlerts: number;
  expiringSecrets: number;
  uptimePercent: number;
}

export interface HealthMatrixEntry {
  service: string;
  health: number;
  availability: number;
  latencyMs: number;
  errorRate: number;
  dependencies: string[];
  lastCheck: string;
  status: ServiceStatus;
}

export interface Incident {
  id: string;
  time: string;
  title: string;
  status: 'open' | 'resolved';
  severity: AlertSeverity;
  affected: string[];
  resolvedAt?: string;
}
