import { useResolvedTheme } from './components/providers';
import Sidebar from './components/Sidebar';
import TopHeader from './components/TopHeader';
import AppRoutes from './AppRoutes';
import { DashboardDataProvider } from './context/DashboardDataContext';

const sidebarWidth = '260px';

export default function App() {
  useResolvedTheme();
  const sidebarOpen = true;

  return (
    <DashboardDataProvider>
      <div className="flex h-screen bg-background text-foreground overflow-hidden">
        <Sidebar className="flex-shrink-0 h-full" width={sidebarWidth} />
        <div className="flex flex-1 flex-col min-w-0">
          <TopHeader sidebarWidth={sidebarWidth} />
          <main className="flex-1 overflow-y-auto scrollbar-thin" style={{ paddingLeft: sidebarOpen ? 260 : 0, paddingTop: 64 }}>
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