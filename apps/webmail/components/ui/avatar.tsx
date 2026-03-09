"use client";

import { useState } from "react";
import { cn } from "@/lib/utils";
import { useSettingsStore } from "@/stores/settings-store";

// Personal email domains where the favicon is the mail provider logo, not the sender
const PERSONAL_DOMAINS = new Set([
  "gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "live.com",
  "msn.com", "yahoo.com", "yahoo.fr", "yahoo.co.uk", "yahoo.co.jp",
  "aol.com", "icloud.com", "me.com", "mac.com", "mail.com",
  "proton.me", "protonmail.com", "pm.me", "tutanota.com", "tuta.com",
  "zoho.com", "yandex.com", "yandex.ru", "gmx.com", "gmx.net",
  "fastmail.com", "hey.com", "posteo.de", "mailbox.org",
]);

interface AvatarProps {
  name?: string;
  email?: string;
  size?: "sm" | "md" | "lg";
  className?: string;
}

export function Avatar({ name, email, size = "md", className }: AvatarProps) {
  const [faviconError, setFaviconError] = useState(false);
  const senderFavicons = useSettingsStore((s) => s.senderFavicons);

  const getInitials = () => {
    if (name) {
      const parts = name.trim().split(/\s+/);
      if (parts.length >= 2) {
        return `${parts[0][0]}${parts[parts.length - 1][0]}`.toUpperCase();
      }
      return name.slice(0, 2).toUpperCase();
    }
    if (email) {
      return email[0].toUpperCase();
    }
    return "?";
  };

  const getBackgroundColor = () => {
    const str = name || email || "";
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      hash = str.charCodeAt(i) + ((hash << 5) - hash);
    }
    const hue = Math.abs(hash) % 360;
    return `hsl(${hue}, 70%, 50%)`;
  };

  const sizeClasses = {
    sm: "w-8 h-8 text-xs",
    md: "w-10 h-10 text-sm",
    lg: "w-12 h-12 text-base",
  };

  const domain = email?.split("@")[1]?.toLowerCase();
  const showFavicon =
    senderFavicons && domain && !PERSONAL_DOMAINS.has(domain) && !faviconError;

  return (
    <div
      className={cn(
        "rounded-full flex items-center justify-center font-semibold text-white overflow-hidden",
        sizeClasses[size],
        className
      )}
      style={{ backgroundColor: getBackgroundColor() }}
      title={name || email}
    >
      {showFavicon ? (
        <img
          src={`/api/favicon?domain=${encodeURIComponent(domain)}`}
          alt=""
          className="w-full h-full object-cover"
          onError={() => setFaviconError(true)}
        />
      ) : (
        getInitials()
      )}
    </div>
  );
}