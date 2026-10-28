import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import Health from './Health';
import Services from './Services';
import Monitoring from './Monitoring';
import Alerts from './Alerts';

const mocks = vi.hoisted(() => ({
  dashboardData: {
    services: [] as Array<Record<string, unknown>>,
    alerts: [] as Array<Record<string, unknown>>,
    healthData: [] as Array<Record<string, unknown>>,
    incidents: [] as Array<Record<string, unknown>>,
    refresh: vi.fn(),
  },
  authentikAccess: vi.fn(),
  metrics: {
    snapshot: {
      cpuPercent: 20,
      memoryPercent: 30,
      diskPercent: 20,
      networkIn: 1_000_000,
      networkOut: 500_000,
      requestRate: 100,
      errorRate: 6,
      activeSessions: 2,
    },
    metrics: {
      cpu: [], memory: [], disk: [], networkIn: [], networkOut: [],
      requestRate: [], errorRate: [], activeSessions: [],
    },
    state: 'live',
    lastRefreshed: new Date('2026-09-24T12:00:00Z').toISOString(),
    refresh: vi.fn(),
  },
}));

vi.mock('../context/DashboardDataContext', () => ({
  useDashboardData: () => mocks.dashboardData,
}));

vi.mock('../lib/api', () => ({
  api: {
    authentikAccess: mocks.authentikAccess,
    acknowledgeAlert: vi.fn(),
    resolveAlert: vi.fn(),
    escalateAlert: vi.fn(),
  },
}));

vi.mock('../hooks/useMetricsPolling', () => ({
  useMetricsPolling: () => mocks.metrics,
}));

vi.mock('../components/ServiceDetailDrawer', () => ({
  default: ({ service, open }: { service?: { name: string }; open: boolean }) =>
    open ? <div>Selected service: {service?.name}</div> : null,
}));

function LocationProbe() {
  return <div>location:{useLocation().pathname}{useLocation().search}</div>;
}

function renderAt(path: string, page: React.ReactNode) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="*" element={page} />
        <Route path="/services" element={<><LocationProbe /><Services /></>} />
        <Route path="/alerts" element={<><LocationProbe /><Alerts /></>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('operational drill-downs', () => {
  beforeEach(() => {
    mocks.dashboardData.services = [{
      id: 'dograh-api', name: 'Dograh API', description: 'Interview workflow API', version: '1',
      status: 'warning', healthScore: 82, cpuUsage: 10, memoryUsage: 20,
      trafficBytesPerSec: 100, lastRestart: '2026-09-24T10:00:00Z', environment: 'prod',
    }];
    mocks.dashboardData.alerts = [{
      id: 'a1', time: '2026-09-24T11:00:00Z', service: 'Dograh API', severity: 'warning',
      message: 'Interview latency is high', status: 'open', assignedTo: 'Voice', tags: [],
    }];
    mocks.dashboardData.healthData = [{
      service: 'Dograh API', health: 82, availability: 99.5, latencyMs: 200,
      errorRate: 3, dependencies: ['postgres'], lastCheck: '2026-09-24T12:00:00Z', status: 'warning',
    }];
    mocks.dashboardData.incidents = [];
    mocks.authentikAccess.mockResolvedValue({
      ok: true, configured: true, baseUrl: '', generatedAt: '2026-09-24T12:00:00Z', error: null,
      summary: { stacks: 0, applications: 0, enforced: 0, ungated: 0, users: 0 },
      stacks: [], users: [], ungated: [], tilesOnly: [],
    });
  });

  it('opens a warning service from Health with status and service preselected', async () => {
    const user = userEvent.setup();
    renderAt('/health', <Health />);
    const healthTable = screen.getByRole('columnheader', { name: 'Service' }).closest('table');
    expect(healthTable).not.toBeNull();
    const row = within(healthTable as HTMLElement).getByText('Dograh API').closest('tr');
    expect(row).not.toBeNull();
    await user.click(within(row as HTMLElement).getByRole('link', { name: /warning/ }));
    expect(await screen.findByText('location:/services?status=warning&service=Dograh%20API')).toBeInTheDocument();
    expect(await screen.findByText('Selected service: Dograh API')).toBeInTheDocument();
  });

  it('opens a critical error-rate card into filtered open alerts', async () => {
    const user = userEvent.setup();
    renderAt('/monitoring', <Monitoring />);
    const card = screen.getByRole('link', { name: /Error Rate/ });
    expect(card).toHaveAttribute('href', '/alerts?severity=critical&status=open');
    await user.click(card);
    expect(await screen.findByText('location:/alerts?severity=critical&status=open')).toBeInTheDocument();
  });

  it('opens the affected service from an alert', async () => {
    const user = userEvent.setup();
    renderAt('/alerts', <Alerts />);
    await user.click(screen.getByRole('link', { name: 'Dograh API' }));
    expect(await screen.findByText('location:/services?service=Dograh%20API')).toBeInTheDocument();
  });

  it('preserves a direct Services deep link and opens its detail drawer', async () => {
    renderAt('/services?status=warning&service=Dograh%20API', <Services />);
    expect(await screen.findByText('Selected service: Dograh API')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Warning' })).toHaveClass('bg-warning/20');
  });
});
