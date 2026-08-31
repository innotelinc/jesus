import { Suspense, lazy } from 'react';
import { Routes, Route } from 'react-router-dom';
import Dashboard from './pages/Dashboard';
import Services from './pages/Services';
import NetworkPorts from './pages/NetworkPorts';
import Health from './pages/Health';
import Monitoring from './pages/Monitoring';
import Secrets from './pages/Secrets';
import PasswordGenerator from './pages/PasswordGenerator';
import Links from './pages/Links';
import Alerts from './pages/Alerts';
import Config from './pages/Config';
import Users from './pages/Users';
import Logs from './pages/Logs';
import Settings from './pages/Settings';

export default function AppRoutes() {
  return (
    <Routes>
      <Route path="/" element={<Dashboard />} />
      <Route path="/services" element={<Services />} />
      <Route path="/ports" element={<NetworkPorts />} />
      <Route path="/health" element={<Health />} />
      <Route path="/monitoring" element={<Monitoring />} />
      <Route path="/secrets" element={<Secrets />} />
      <Route path="/password" element={<PasswordGenerator />} />
      <Route path="/softphone" element={(
        <Suspense fallback={<div className="p-8 text-sm text-muted-foreground">Loading softphone…</div>}>
          <LazySoftphone />
        </Suspense>
      )} />
      <Route path="/links" element={<Links />} />
      <Route path="/alerts" element={<Alerts />} />
      <Route path="/config" element={<Config />} />
      <Route path="/users" element={<Users />} />
      <Route path="/logs" element={<Logs />} />
      <Route path="/settings" element={<Settings />} />
    </Routes>
  );
}

// SIP.js (~150 kB gzipped) is only needed on the softphone page — lazy-load it
// so the rest of the dashboard doesn't pay the cost on first paint.
const LazySoftphone = lazy(() => import('./pages/Softphone'));
