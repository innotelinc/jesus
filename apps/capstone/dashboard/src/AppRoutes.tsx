import { Suspense, lazy } from 'react';
import { Routes, Route } from 'react-router-dom';

// Every page is code-split so the initial bundle is just the app shell + the
// landing page — the other views load on demand (and stay cached after).
const Dashboard = lazy(() => import('./pages/Dashboard'));
const Services = lazy(() => import('./pages/Services'));
const NetworkPorts = lazy(() => import('./pages/NetworkPorts'));
const Health = lazy(() => import('./pages/Health'));
const Monitoring = lazy(() => import('./pages/Monitoring'));
const Secrets = lazy(() => import('./pages/Secrets'));
const PasswordGenerator = lazy(() => import('./pages/PasswordGenerator'));
const Softphone = lazy(() => import('./pages/Softphone'));
const Links = lazy(() => import('./pages/Links'));
const Alerts = lazy(() => import('./pages/Alerts'));
const Config = lazy(() => import('./pages/Config'));
const Users = lazy(() => import('./pages/Users'));
const Logs = lazy(() => import('./pages/Logs'));
const Settings = lazy(() => import('./pages/Settings'));

function PageFallback() {
  return (
    <div className="flex min-h-[40vh] items-center justify-center">
      <div className="flex items-center gap-3 text-sm text-muted-foreground">
        <span className="inline-flex h-2 w-2 animate-pulse-slow rounded-full bg-primary" />
        Loading…
      </div>
    </div>
  );
}

export default function AppRoutes() {
  return (
    <Suspense fallback={<PageFallback />}>
      <Routes>
        <Route path="/" element={<Dashboard />} />
        <Route path="/services" element={<Services />} />
        <Route path="/ports" element={<NetworkPorts />} />
        <Route path="/health" element={<Health />} />
        <Route path="/monitoring" element={<Monitoring />} />
        <Route path="/secrets" element={<Secrets />} />
        <Route path="/password" element={<PasswordGenerator />} />
        <Route path="/softphone" element={<Softphone />} />
        <Route path="/links" element={<Links />} />
        <Route path="/alerts" element={<Alerts />} />
        <Route path="/config" element={<Config />} />
        <Route path="/users" element={<Users />} />
        <Route path="/logs" element={<Logs />} />
        <Route path="/settings" element={<Settings />} />
      </Routes>
    </Suspense>
  );
}