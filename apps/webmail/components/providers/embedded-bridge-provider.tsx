"use client";

import { useEffect } from "react";
import { isEmbedded, listenFromParent } from "@/lib/iframe-bridge";
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
          const segments = window.location.pathname.split("/").filter(Boolean);
          const locale = segments[0] || "en";
          window.location.href = `/${locale}/login`;
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
