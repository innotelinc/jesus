import { useSearchParams } from 'react-router-dom';
import { useResolvedTheme } from './components/providers';
import Sidebar from './components/Sidebar';
import TopHeader from './components/TopHeader';
import AppRoutes from './AppRoutes';
import { DashboardDataProvider } from './context/DashboardDataContext';

const sidebarWidth = '240px';

/** Gate failures set `?auth_error=` on the callback redirect; explain them. */
const AUTH_ERRORS: Record<string, string> = {
  no_tenant:
    'Your account has no tenant here — join an Authentik group whose name matches this dashboard\u2019s tenant (or ask a platform admin to add it).',
  not_authorized: 'This account is not allowed to use the control center.',
  state_mismatch: 'That sign-in attempt expired. Please try again.',
};

function AuthErrorBanner() {
  const [params, setParams] = useSearchParams();
  const code = params.get('auth_error');
  if (!code) return null;
  const dismiss = () => {
    const next = new URLSearchParams(params);
    next.delete('auth_error');
    setParams(next, { replace: true });
  };
  return (
    <div
      role="alert"
      className="mb-6 flex items-start gap-3 rounded-xl border border-danger/30 bg-danger/10 px-4 py-3 text-sm text-danger"
    >
      <span className="flex-1">{AUTH_ERRORS[code] ?? `Sign-in failed (${code}).`}</span>
      <button
        type="button"
        onClick={dismiss}
        className="shrink-0 rounded-md px-2 py-0.5 text-xs font-medium transition-colors hover:bg-danger/10"
      >
        Dismiss
      </button>
    </div>
  );
}

export default function App() {
  useResolvedTheme();

  return (
    <DashboardDataProvider>
      <div className="flex h-screen bg-background text-foreground overflow-hidden">
        <Sidebar className="flex-shrink-0 h-full" width={sidebarWidth} />
        <div className="flex flex-1 flex-col min-w-0">
          <TopHeader sidebarWidth={sidebarWidth} />
          {/* The flex row already reserves `sidebarWidth` for the sidebar and the
              fixed header floats above — only pad the top so content clears it. */}
          <main className="flex-1 overflow-y-auto scrollbar-thin" style={{ paddingTop: 56 }}>
            <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 py-6">
              <AuthErrorBanner />
              <div className="animate-in">
                <AppRoutes />
              </div>
            </div>
          </main>
        </div>
      </div>
    </DashboardDataProvider>
  );
}