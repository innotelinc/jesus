"use client";

import { useEffect, useMemo, useState, type ComponentType, type DragEvent } from "react";
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
import { ProTabBar, PRO_TAB_DRAG_MIME } from "@/components/pro/pro-tab-bar";
import { useProTabStore, type ProTab, type ProTabKind, type ProPaneId } from "@/stores/pro-tab-store";
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

type DropTarget = 'left' | 'right' | 'top' | 'bottom' | null;

function renderTabBody(tab: ProTab): React.ReactNode {
  if (tab.kind === 'compose' && tab.composeData) {
    return <ProComposeTabBody tabId={tab.id} data={tab.composeData} />;
  }
  if (tab.kind === 'email' && tab.emailData) {
    return <ProEmailTabBody tabId={tab.id} data={tab.emailData} />;
  }
  const Component = APP_TAB_COMPONENTS[tab.kind];
  return Component ? <Component /> : null;
}

interface PaneProps {
  paneId: ProPaneId;
  tabs: ProTab[];
  activeTabId: string | null;
  loadedTabIds: string[];
  allTabs: ProTab[];
  onActivate: (id: string) => void;
  onClose: (id: string) => void;
  onDragStateChange: (dragging: boolean) => void;
  onPaneFocus: (paneId: ProPaneId) => void;
  isFocused: boolean;
}

function Pane({
  paneId, tabs, activeTabId, loadedTabIds, allTabs,
  onActivate, onClose, onDragStateChange, onPaneFocus, isFocused,
}: PaneProps) {
  return (
    <div
      className="flex flex-1 flex-col overflow-hidden min-w-0 min-h-0"
      onMouseDownCapture={() => { if (!isFocused) onPaneFocus(paneId); }}
    >
      <ProTabBar
        tabs={tabs}
        activeTabId={activeTabId}
        paneId={paneId}
        onActivate={onActivate}
        onClose={onClose}
        onDragStateChange={onDragStateChange}
      />
      <div className="relative flex-1 min-h-0">
        {allTabs
          .filter((tab) => tab.paneId === paneId && loadedTabIds.includes(tab.id))
          .map((tab) => {
            const isActive = tab.id === activeTabId;
            return (
              <div
                key={tab.id}
                className={cn("absolute inset-0 overflow-hidden", !isActive && "hidden")}
                aria-hidden={!isActive}
              >
                {renderTabBody(tab)}
              </div>
            );
          })}
      </div>
    </div>
  );
}

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
  const activeMainTabId = useProTabStore((s) => s.activeTabId);
  const activeSplitTabId = useProTabStore((s) => s.activeSplitTabId);
  const splitOrientation = useProTabStore((s) => s.splitOrientation);
  const focusedPaneId = useProTabStore((s) => s.focusedPaneId);
  const loadedTabIds = useProTabStore((s) => s.loadedTabIds);
  const openTab = useProTabStore((s) => s.openTab);
  const closeTab = useProTabStore((s) => s.closeTab);
  const setActiveTab = useProTabStore((s) => s.setActiveTab);
  const setFocusedPane = useProTabStore((s) => s.setFocusedPane);
  const moveTabToPane = useProTabStore((s) => s.moveTabToPane);

  const [isTabDragging, setIsTabDragging] = useState(false);
  const [splitDropTarget, setSplitDropTarget] = useState<DropTarget>(null);

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

  const mainTabs = useMemo(() => tabs.filter((t) => t.paneId === 'main'), [tabs]);
  const splitTabs = useMemo(() => tabs.filter((t) => t.paneId === 'split'), [tabs]);

  const focusedActiveTab = useMemo(() => {
    const id = focusedPaneId === 'main' ? activeMainTabId : activeSplitTabId;
    return tabs.find((t) => t.id === id) ?? null;
  }, [tabs, focusedPaneId, activeMainTabId, activeSplitTabId]);

  const handleRailNavigate = (itemId: 'mail' | 'calendar' | 'contacts' | 'files' | 'settings') => {
    openTab(itemId);
    return true;
  };

  const railActiveItemId: 'mail' | 'calendar' | 'contacts' | 'files' | 'settings' | null =
    focusedActiveTab && (
      focusedActiveTab.kind === 'mail' || focusedActiveTab.kind === 'calendar'
      || focusedActiveTab.kind === 'contacts' || focusedActiveTab.kind === 'files'
      || focusedActiveTab.kind === 'settings'
    ) ? focusedActiveTab.kind : null;

  // ---- Split drop zones ----

  const isProTabDrag = (e: DragEvent) => e.dataTransfer.types.includes(PRO_TAB_DRAG_MIME);

  const computeDropTarget = (e: DragEvent<HTMLDivElement>): DropTarget => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const xFrac = x / rect.width;
    const yFrac = y / rect.height;
    // Edges: outer 22% of the body becomes a split drop target. The cursor's
    // dominant axis decides which side activates.
    const fromLeft = xFrac;
    const fromRight = 1 - xFrac;
    const fromTop = yFrac;
    const fromBottom = 1 - yFrac;
    const min = Math.min(fromLeft, fromRight, fromTop, fromBottom);
    if (min > 0.22) return null;
    if (min === fromRight) return 'right';
    if (min === fromLeft) return 'left';
    if (min === fromBottom) return 'bottom';
    return 'top';
  };

  const handleBodyDragOver = (e: DragEvent<HTMLDivElement>) => {
    if (!isProTabDrag(e)) return;
    if (splitOrientation !== null) return; // already split — body drops disabled
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const next = computeDropTarget(e);
    if (next !== splitDropTarget) setSplitDropTarget(next);
  };

  const handleBodyDragLeave = (e: DragEvent<HTMLDivElement>) => {
    const next = e.relatedTarget as Node | null;
    if (next && e.currentTarget.contains(next)) return;
    setSplitDropTarget(null);
  };

  const handleBodyDrop = (e: DragEvent<HTMLDivElement>) => {
    if (!isProTabDrag(e)) return;
    if (splitOrientation !== null) return;
    const target = computeDropTarget(e);
    setSplitDropTarget(null);
    setIsTabDragging(false);
    if (!target) return;
    e.preventDefault();
    const draggedId = e.dataTransfer.getData(PRO_TAB_DRAG_MIME);
    if (!draggedId) return;
    // The dragged tab must currently be in 'main' (the only pane right now).
    // Moving it to 'split' creates the split.
    const orientation = (target === 'left' || target === 'right') ? 'vertical' : 'horizontal';
    moveTabToPane(draggedId, 'split', orientation);
    // 'left'/'top' targets put the split pane on the leading edge — flipped
    // visually by swapping the rendered order below. We track it via the
    // splitLeading flag derived from the last drop.
    setSplitLeading(target === 'left' || target === 'top');
  };

  // Whether the split pane renders before (true) or after (false) the main pane.
  const [splitLeading, setSplitLeading] = useState(false);

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

  const isSplit = splitOrientation !== null && splitTabs.length > 0;

  const mainPane = (
    <Pane
      paneId="main"
      tabs={mainTabs}
      activeTabId={activeMainTabId}
      loadedTabIds={loadedTabIds}
      allTabs={tabs}
      onActivate={setActiveTab}
      onClose={closeTab}
      onDragStateChange={setIsTabDragging}
      onPaneFocus={setFocusedPane}
      isFocused={focusedPaneId === 'main'}
    />
  );

  const splitPane = isSplit ? (
    <Pane
      paneId="split"
      tabs={splitTabs}
      activeTabId={activeSplitTabId}
      loadedTabIds={loadedTabIds}
      allTabs={tabs}
      onActivate={setActiveTab}
      onClose={closeTab}
      onDragStateChange={setIsTabDragging}
      onPaneFocus={setFocusedPane}
      isFocused={focusedPaneId === 'split'}
    />
  ) : null;

  const splitDivider = isSplit ? (
    <div
      aria-hidden="true"
      className={cn(
        "flex-shrink-0 bg-transparent",
        splitOrientation === 'vertical' ? "w-px" : "h-px",
      )}
      style={
        splitOrientation === 'vertical'
          ? { borderLeft: '1px solid rgba(128, 128, 128, 0.3)' }
          : { borderTop: '1px solid rgba(128, 128, 128, 0.3)' }
      }
    />
  ) : null;

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
            <div
              className={cn(
                "relative flex flex-1 overflow-hidden min-w-0",
                isSplit && splitOrientation === 'horizontal' ? "flex-col" : "flex-row",
              )}
              onDragOver={handleBodyDragOver}
              onDragLeave={handleBodyDragLeave}
              onDrop={handleBodyDrop}
            >
              {isSplit
                ? (splitLeading
                    ? <>{splitPane}{splitDivider}{mainPane}</>
                    : <>{mainPane}{splitDivider}{splitPane}</>)
                : mainPane}

              {/* Split-creation drop zones — shown only while a tab is being
                  dragged and the body isn't already split. */}
              {isTabDragging && !isSplit && (
                <>
                  <DropZone active={splitDropTarget === 'left'} side="left" />
                  <DropZone active={splitDropTarget === 'right'} side="right" />
                  <DropZone active={splitDropTarget === 'top'} side="top" />
                  <DropZone active={splitDropTarget === 'bottom'} side="bottom" />
                </>
              )}
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

function DropZone({ active, side }: { active: boolean; side: 'left' | 'right' | 'top' | 'bottom' }) {
  const isVertical = side === 'left' || side === 'right';
  return (
    <div
      aria-hidden="true"
      className={cn(
        "pointer-events-none absolute z-10 transition-colors duration-100",
        isVertical ? "top-0 bottom-0 w-[22%]" : "left-0 right-0 h-[22%]",
        side === 'left' && "left-0",
        side === 'right' && "right-0",
        side === 'top' && "top-0",
        side === 'bottom' && "bottom-0",
        active ? "bg-primary/15 ring-2 ring-primary/40 ring-inset" : "bg-transparent",
      )}
    />
  );
}
