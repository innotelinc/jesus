import { ToastProvider, Loading } from './ui.jsx';
import { AuthProvider, useAuth } from './auth.jsx';
import { navigate, useLocation } from './router.jsx';
import Shell from './Shell.jsx';
import Login from './pages/Login.jsx';
import Dashboard from './pages/Dashboard.jsx';
import Numbers from './pages/Numbers.jsx';
import Calls from './pages/Calls.jsx';
import Extensions from './pages/Extensions.jsx';
import Trunks from './pages/Trunks.jsx';
import Ivr from './pages/Ivr.jsx';
import Moderation from './pages/Moderation.jsx';
import Voice from './pages/Voice.jsx';
import Workflows from './pages/Workflows.jsx';
import Voicemail from './pages/Voicemail.jsx';
import Fax from './pages/Fax.jsx';
import Messages from './pages/Messages.jsx';
import Billing from './pages/Billing.jsx';
import Estate from './pages/Estate.jsx';
import Health from './pages/Health.jsx';
import Operations from './pages/Operations.jsx';
import Settings from './pages/Settings.jsx';
import Systems from './pages/Systems.jsx';
import Softphone from './pages/Softphone.jsx';
import PublicDirectory from './pages/PublicDirectory.jsx';

const PAGES = [
  { path: '/', title: 'Dashboard', subtitle: 'Platform and registry at a glance', Component: Dashboard },
  { path: '/calls', title: 'Call history', subtitle: 'Live and completed calls', Component: Calls },
  { path: '/softphone', title: 'Softphone', subtitle: 'Encrypted audio and video in the browser', Component: Softphone },
  { path: '/extensions', title: 'Extensions', subtitle: 'Devices and voicemail boxes', Component: Extensions },
  { path: '/trunks', title: 'Trunks', subtitle: 'Carrier and SIP connectivity', Component: Trunks },
  { path: '/ivr', title: 'Call routing', subtitle: 'Menus, inbound DIDs and destinations', Component: Ivr },
  { path: '/voicemail', title: 'Voicemail', subtitle: 'Recorded messages and transcripts', Component: Voicemail },
  { path: '/fax', title: 'Fax', subtitle: 'Inbound documents and outbound sends', Component: Fax },
  { path: '/messages', title: 'Messages', subtitle: 'SMS, MMS and WhatsApp on your numbers', Component: Messages },
  { path: '/voice', title: 'Voice agents', subtitle: 'Personas that answer and place calls', Component: Voice },
  { path: '/workflows', title: 'Workflows', subtitle: 'Triggered automation with recorded runs', Component: Workflows },
  { path: '/numbers', title: 'Number registry', subtitle: 'One canonical row per E.164 number', Component: Numbers },
  { path: '/directory', title: 'Moderation', subtitle: 'Submitted listings awaiting review', Component: Moderation },
  { path: '/billing', title: 'Billing', subtitle: 'Invoices grouped by currency', Component: Billing },
  { path: '/estate', title: 'Estate', subtitle: 'Sites and the equipment installed at them', Component: Estate },
  { path: '/health', title: 'Health', subtitle: 'Live probes across the container', Component: Health },
  { path: '/operations', title: 'Operations', subtitle: 'Incidents, changes and provisioning', Component: Operations },
  { path: '/systems', title: 'Connected systems', subtitle: 'The consoles this platform sits beside', Component: Systems },
  { path: '/settings', title: 'Settings', subtitle: 'Domains, API keys and telephony', Component: Settings },
];

function Router() {
  const { pathname, search } = useLocation();
  const { status } = useAuth();

  // Public directory: /d/<host> and /lookup?number=...
  if (pathname.startsWith('/d/') || pathname === '/lookup') {
    return <PublicDirectory host={decodeURIComponent(pathname.replace('/d/', ''))} search={search} />;
  }

  if (pathname === '/login') {
    if (status === 'ready') {
      navigate('/', { replace: true });
      return null;
    }
    return <Login />;
  }

  if (status === 'loading') {
    return (
      <div style={{ display: 'grid', placeItems: 'center', minHeight: '100dvh' }}>
        <Loading rows={2} />
      </div>
    );
  }

  if (status === 'anon') {
    if (pathname !== '/') navigate('/login', { replace: true });
    return <Login />;
  }

  // The softphone's own window: one document, one registration, no console
  // around it — so it keeps the line while the console is navigated.
  if (pathname === '/softphone' && new URLSearchParams(search).get('window') === '1') {
    return (
      <div className="popout">
        <Softphone />
      </div>
    );
  }

  const route = PAGES.find((page) => page.path === pathname);
  if (!route) {
    return (
      <Shell path={pathname} title="Not found" subtitle={pathname}>
        <div className="card">
          <div className="empty">
            <strong>That page does not exist</strong>
            <a className="btn primary sm" href="/">
              Back to the dashboard
            </a>
          </div>
        </div>
      </Shell>
    );
  }

  return (
    <Shell path={pathname} title={route.title} subtitle={route.subtitle}>
      <route.Component />
    </Shell>
  );
}

export default function App() {
  return (
    <ToastProvider>
      <AuthProvider>
        <Router />
      </AuthProvider>
    </ToastProvider>
  );
}
