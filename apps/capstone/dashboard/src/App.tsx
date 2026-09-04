import { useResolvedTheme } from './components/providers';
import Sidebar from './components/Sidebar';
import TopHeader from './components/TopHeader';
import AppRoutes from './AppRoutes';
import { DashboardDataProvider } from './context/DashboardDataContext';

const sidebarWidth = '240px';

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