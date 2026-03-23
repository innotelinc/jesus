"use client";

import { useEffect } from "react";
import { isEmbedded, listenFromParent } from "@/lib/iframe-bridge";
import { getPathPrefix, getLocaleFromPath } from "@/lib/browser-navigation";
import { useAuthStore } from "@/stores/auth-store";
import { useConfig } from "@/hooks/use-config";

export function EmbeddedBridgeProvider({ children }: { children: React.ReactNode }) {
  const { parentOrigin, embeddedMode } = useConfig();
  const logout = useAuthStore((s) => s.logout);

  useEffect(() => {
    if (!embeddedMode || !isEmbedded()) return;

    const unsubscribe = listenFromParent((msg) => {
      switch (msg.type) {
        case "sso:trigger-login": {
          // Navigate to login page to start SSO flow
          const prefix = getPathPrefix();
          const locale = getLocaleFromPath();
          window.location.href = `${prefix}/${locale}/login`;
          break;
        }
        case "sso:trigger-logout":
          logout();
          break;
      }
    }, parentOrigin || undefined);

    return unsubscribe;
  }, [embeddedMode, parentOrigin, logout]);

  return <>{children}</>;
}
