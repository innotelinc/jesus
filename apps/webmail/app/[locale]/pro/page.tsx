"use client";

import { useEffect, useMemo, useState, type ComponentType } from "react";
import { useTranslations } from "next-intl";
import { NavigationRail } from "@/components/layout/navigation-rail";
import { KeyboardShortcutsModal } from "@/components/keyboard-shortcuts-modal";
import { SidebarAppsModal } from "@/components/layout/sidebar-apps-modal";
import { InlineAppView } from "@/components/layout/inline-app-view";
import { useSidebarApps } from "@/hooks/use-sidebar-apps";
import { useAuthStore, redirectToLogin } from "@/stores/auth-store";
import { useEmailStore } from "@/stores/email-store";
import { useDeviceDetection } from "@/hooks/use-media-query";
import { EmbeddedContext } from "@/hooks/use-is-embedded";
import { ProTabBar } from "@/components/pro/pro-tab-bar";
import { useProTabStore, type ProTabKind } from "@/stores/pro-tab-store";
import { cn } from "@/lib/utils";

import MailPage from "@/app/[locale]/page";
import CalendarPage from "@/app/[locale]/calendar/page";
import ContactsPage from "@/app/[locale]/contacts/page";
import FilesPage from "@/app/[locale]/files/page";
import SettingsPage from "@/app/[locale]/settings/page";
import { ProComposeTabBody } from "@/components/pro/pro-compose-tab-body";
import { ProEmailTabBody } from "@/components/pro/pro-email-tab-body";

const APP_TAB_COMPONENTS: Partial<Record<ProTabKind, ComponentType>> = {
  mail: MailPage,
  calendar: CalendarPage,
  contacts: ContactsPage,
  files: FilesPage,
  settings: SettingsPage,
};

export default function ProHome() {
  const t = useTranslations();
  const { isMobile, isTablet, isDesktop } = useDeviceDetection();

  const [initialCheckDone, setInitialCheckDone] = useState(
    () => useAuthStore.getState().isAuthenticated && !!useAuthStore.getState().client
  );
  const [showShortcutsModal, setShowShortcutsModal] = useState(false);
  const {
    showAppsModal,
    inlineApp,
    loadedApps,
    handleManageApps,
    handleInlineApp,
    closeInlineApp,
    closeAppsModal,
  } = useSidebarApps();

  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const client = useAuthStore((s) => s.client);
  const logout = useAuthStore((s) => s.logout);
  const checkAuth = useAuthStore((s) => s.checkAuth);
  const authLoading = useAuthStore((s) => s.isLoading);
  const quota = useEmailStore((s) => s.quota);
  const isPushConnected = useEmailStore((s) => s.isPushConnected);

  const tabs = useProTabStore((s) => s.tabs);
  const activeTabId = useProTabStore((s) => s.activeTabId);
  const loadedTabIds = useProTabStore((s) => s.loadedTabIds);
  const openTab = useProTabStore((s) => s.openTab);
  const closeTab = useProTabStore((s) => s.closeTab);
  const setActiveTab = useProTabStore((s) => s.setActiveTab);

  // Auth bootstrap (mirrors standard page)
  useEffect(() => {
    const state = useAuthStore.getState();
    if (state.isAuthenticated && state.client) {
      setInitialCheckDone(true);
      return;
    }
    checkAuth().finally(() => {
      setInitialCheckDone(true);
    });
  }, [checkAuth]);

  useEffect(() => {
    if (initialCheckDone && !isAuthenticated && !authLoading) {
      redirectToLogin();
    }
  }, [initialCheckDone, isAuthenticated, authLoading]);

  // Pro is desktop-only — fall back to standard on mobile/tablet
  useEffect(() => {
    if (initialCheckDone && (isMobile || isTablet) && typeof window !== "undefined") {
      window.location.replace("/");
    }
  }, [initialCheckDone, isMobile, isTablet]);

  const activeTab = useMemo(
    () => tabs.find((tab) => tab.id === activeTabId) ?? tabs[0],
    [tabs, activeTabId]
  );

  const handleRailNavigate = (itemId: 'mail' | 'calendar' | 'contacts' | 'files' | 'settings') => {
    openTab(itemId);
    return true;
  };

  // Only highlight the rail when an "app" tab is active; compose/email tabs
  // don't correspond to any rail item.
  const railActiveItemId: 'mail' | 'calendar' | 'contacts' | 'files' | 'settings' | null =
    activeTab && (
      activeTab.kind === 'mail' || activeTab.kind === 'calendar'
      || activeTab.kind === 'contacts' || activeTab.kind === 'files'
      || activeTab.kind === 'settings'
    ) ? activeTab.kind : null;

  // Loading state (matches standard page exactly)
  if (!initialCheckDone || authLoading || !isAuthenticated || !client) {
    return (
      <div className="flex h-screen items-center justify-center bg-background">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-foreground mx-auto"></div>
          <p className="mt-4 text-sm text-muted-foreground">{t("common.loading")}</p>
        </div>
      </div>
    );
  }

  if (!isDesktop) return null;

  return (
    <EmbeddedContext.Provider value={true}>
      <div className="flex flex-col h-dvh bg-background overflow-hidden pt-[env(safe-area-inset-top)]">
        <div className="flex flex-1 overflow-hidden">
          {/* Leftmost Navigation Rail — identical to the standard layout */}
          <div
            className="w-14 bg-secondary flex flex-col flex-shrink-0"
            style={{ borderRight: '1px solid rgba(128, 128, 128, 0.3)' }}
          >
            <NavigationRail
              collapsed
              quota={quota}
              isPushConnected={isPushConnected}
              onLogout={logout}
              onShowShortcuts={() => setShowShortcutsModal(true)}
              onManageApps={handleManageApps}
              onInlineApp={handleInlineApp}
              onCloseInlineApp={closeInlineApp}
              activeAppId={inlineApp?.id ?? null}
              onNavigate={handleRailNavigate}
              activeItemId={railActiveItemId}
            />
          </div>

          {inlineApp && (
            <InlineAppView
              apps={loadedApps}
              activeAppId={inlineApp.id}
              onClose={closeInlineApp}
              className="flex-1"
            />
          )}

          {!inlineApp && (
            <div className="flex flex-1 flex-col overflow-hidden min-w-0">
              <ProTabBar
                tabs={tabs}
                activeTabId={activeTabId}
                onActivate={setActiveTab}
                onClose={closeTab}
              />

              {/* Tab bodies — every loaded tab stays mounted so flipping tabs
                  preserves the page's internal state (selection, scroll,
                  drafts). Inactive ones are hidden via CSS. */}
              <div className="relative flex-1 min-h-0">
                {tabs
                  .filter((tab) => loadedTabIds.includes(tab.id))
                  .map((tab) => {
                    const isActive = tab.id === activeTabId;
                    let body: React.ReactNode = null;
                    if (tab.kind === 'compose' && tab.composeData) {
                      body = <ProComposeTabBody tabId={tab.id} data={tab.composeData} />;
                    } else if (tab.kind === 'email' && tab.emailData) {
                      body = <ProEmailTabBody tabId={tab.id} data={tab.emailData} />;
                    } else {
                      const Component = APP_TAB_COMPONENTS[tab.kind];
                      if (Component) body = <Component />;
                    }
                    return (
                      <div
                        key={tab.id}
                        className={cn("absolute inset-0 overflow-hidden", !isActive && "hidden")}
                        aria-hidden={!isActive}
                      >
                        {body}
                      </div>
                    );
                  })}
              </div>
            </div>
          )}
        </div>

        <KeyboardShortcutsModal
          isOpen={showShortcutsModal}
          onClose={() => setShowShortcutsModal(false)}
        />
        {showAppsModal && (
          <SidebarAppsModal isOpen={showAppsModal} onClose={closeAppsModal} />
        )}
      </div>
    </EmbeddedContext.Provider>
  );
}
