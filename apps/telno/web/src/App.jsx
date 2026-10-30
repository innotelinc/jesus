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
import Account from './pages/Account.jsx';
import Systems from './pages/Systems.jsx';
import Softphone from './pages/Softphone.jsx';
import Marketing from './pages/Marketing.jsx';
import Plans from './pages/Plans.jsx';
import Subscribe from './pages/Subscribe.jsx';
import Site from './pages/Site.jsx';
import PublicDirectory from './pages/PublicDirectory.jsx';
import Customer from './pages/Customer.jsx';
import Customers from './pages/Customers.jsx';
import Setup, { useSetupStatus } from './pages/Setup.jsx';
import Onboarding from './pages/Onboarding.jsx';
import { entryPath } from './sites.js';

const PAGES = [
  { path: '/', title: 'Dashboard', subtitle: 'Platform and registry at a glance', Component: Dashboard },
  { path: '/setup', title: 'Get started', subtitle: 'The line, number and registration a fresh install needs', Component: Setup },
  { path: '/calls', title: 'Call history', subtitle: 'Live and completed calls', Component: Calls },
  { path: '/softphone', title: 'Softphone', subtitle: 'Encrypted audio and video in the browser', Component: Softphone },
  { path: '/extensions', title: 'Extensions', subtitle: 'Devices and voicemail boxes', Component: Extensions },
  { path: '/trunks', title: 'Trunks', subtitle: 'Carrier and gateway connectivity', Component: Trunks },
  { path: '/ivr', title: 'Call routing', subtitle: 'Menus, inbound DIDs and destinations', Component: Ivr },
  { path: '/voicemail', title: 'Voicemail', subtitle: 'Recorded messages and transcripts', Component: Voicemail },
  { path: '/fax', title: 'Fax', subtitle: 'Inbound documents and outbound sends', Component: Fax },
  { path: '/messages', title: 'Messages', subtitle: 'Texts on your numbers, and secure messages between people on this platform', Component: Messages },
  { path: '/voice', title: 'Voice agents', subtitle: 'Personas that answer and place calls', Component: Voice },
  { path: '/marketing', title: 'Marketing', subtitle: 'Outbound campaigns with graded reports', Component: Marketing },
  { path: '/workflows', title: 'Workflows', subtitle: 'Triggered automation with recorded runs', Component: Workflows },
  { path: '/numbers', title: 'Number registry', subtitle: 'One canonical row per E.164 number', Component: Numbers },
  { path: '/directory', title: 'Moderation', subtitle: 'Submitted listings awaiting review', Component: Moderation },
  { path: '/customers', title: 'Customers', subtitle: 'One record per customer: plan, lines, bills, calls and what is waiting on us', Component: Customers },
  { path: '/billing', title: 'Billing', subtitle: 'Invoices grouped by currency', Component: Billing },
  { path: '/plans', title: 'Plans and subscriptions', subtitle: 'What the subscribe page sells and who is paying', Component: Plans },
  { path: '/estate', title: 'Estate', subtitle: 'Sites and the equipment installed at them', Component: Estate },
  { path: '/health', title: 'Health', subtitle: 'Live probes across the container', Component: Health },
  { path: '/operations', title: 'Operations', subtitle: 'Incidents, changes and provisioning', Component: Operations },
  { path: '/systems', title: 'Connected systems', subtitle: 'The consoles this platform sits beside', Component: Systems },
  { path: '/settings', title: 'Settings', subtitle: 'Domains, API keys and telephony', Component: Settings },
  { path: '/account', title: 'Account', subtitle: 'Your password and the credential this install started with', Component: Account },
];

function Router() {
  const { pathname, search } = useLocation();
  const { status, user, reason, onboarding } = useAuth();
  // Whether this install still has no line at all: the one thing that makes the
  // console empty rather than busy, and the reason a first run starts on setup.
  const setup = useSetupStatus(status === 'ready' && (user?.kind || 'staff') !== 'customer');

  // Public directory: /d/<host> and /lookup?number=...
  if (pathname.startsWith('/d/') || pathname === '/lookup') {
    return <PublicDirectory host={decodeURIComponent(pathname.replace('/d/', ''))} search={search} />;
  }

  // A directory domain has no shop window: telno.directory *is* the phonebook,
  // so its root opens the directory rather than a landing page about it. The
  // edge proxy sends the same redirect; doing it here as well means the domain
  // behaves the same behind any proxy, or on a port with no proxy at all.
  const directoryEntry = entryPath(window.location.host);
  if (directoryEntry && pathname === '/') {
    navigate(directoryEntry, { replace: true });
    return null;
  }

  // The shop window. Public on purpose: a stranger has to be able to reach it,
  // and an unpaid customer is sent here rather than to a login form.
  if (pathname === '/welcome') {
    return <Site />;
  }
  if (pathname === '/subscribe') {
    return <Subscribe user={user} locked={status === 'unpaid' ? reason : null} />;
  }

  // The first login comes before the plans, and before the console: terms,
  // details, address, phone and a line, in that order. The server refuses every
  // other route until then, so this is the door rather than a greeting — and a
  // subscriber whose payment has not settled can still walk through it.
  if (onboarding?.required) {
    return <Onboarding />;
  }

  // A valid session without a paid subscription gets the plans, not the console.
  if (status === 'unpaid') {
    return <Subscribe user={user} locked={reason} />;
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
    // A visitor who is not signed in lands on the site, not on a login form:
    // the console is a paid product and the site is how somebody buys it.
    if (pathname === '/') return <Site />;
    navigate('/login', { replace: true });
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

  // A subscriber gets the customer portal, not the operator's console: their
  // own line, plan and invoices, and no way through to the switch.
  if (user?.kind === 'customer') {
    return <Customer />;
  }

  // A switch with no line cannot place a call, so the dashboard is the wrong
  // place to land first. Only the dashboard redirects: Settings and Numbers are
  // needed to finish setting up, so they stay reachable.
  if (setup?.needed && pathname === '/') {
    navigate('/setup', { replace: true });
    return null;
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
