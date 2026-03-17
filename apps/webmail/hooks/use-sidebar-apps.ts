import { useState, useCallback } from 'react';
import { useSettingsStore } from '@/stores/settings-store';

export interface InlineAppState {
  id: string;
  url: string;
  name: string;
}

export function useSidebarApps() {
  const [showAppsModal, setShowAppsModal] = useState(false);
  const [inlineApp, setInlineApp] = useState<InlineAppState | null>(null);
  const [loadedApps, setLoadedApps] = useState<InlineAppState[]>([]);
  const keepAppsLoaded = useSettingsStore((s) => s.keepAppsLoaded);

  const handleManageApps = useCallback(() => {
    setShowAppsModal(true);
  }, []);

  const handleInlineApp = useCallback((appId: string, url: string, name: string) => {
    const app = { id: appId, url, name };
    setInlineApp(app);
    setLoadedApps((prev) => {
      if (prev.some((a) => a.id === appId)) return prev;
      return [...prev, app];
    });
  }, []);

  const closeInlineApp = useCallback(() => {
    if (!keepAppsLoaded) {
      setLoadedApps((prev) => prev.filter((a) => a.id !== inlineApp?.id));
    }
    setInlineApp(null);
  }, [keepAppsLoaded, inlineApp]);

  const closeAppsModal = useCallback(() => {
    setShowAppsModal(false);
  }, []);

  return {
    showAppsModal,
    inlineApp,
    loadedApps: keepAppsLoaded ? loadedApps : (inlineApp ? [inlineApp] : []),
    handleManageApps,
    handleInlineApp,
    closeInlineApp,
    closeAppsModal,
  };
}
