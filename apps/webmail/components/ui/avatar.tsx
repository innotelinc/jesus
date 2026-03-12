"use client";

import { useState, useCallback } from "react";
import { cn } from "@/lib/utils";
import { useSettingsStore } from "@/stores/settings-store";

const IS_DEV = process.env.NODE_ENV !== "production";

// Module-level cache of domains whose favicons failed to load.
// Shared across all Avatar instances to avoid re-requesting known-bad domains.
const failedFaviconDomains = new Set<string>();
// Personal email domains where the favicon is the mail provider logo, not the sender
const PERSONAL_DOMAINS = new Set([
  "gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "live.com",
  "msn.com", "yahoo.com", "yahoo.fr", "yahoo.co.uk", "yahoo.co.jp",
  "aol.com", "icloud.com", "me.com", "mac.com", "mail.com",
  "proton.me", "protonmail.com", "pm.me", "tutanota.com", "tuta.com",
  "zoho.com", "yandex.com", "yandex.ru", "gmx.com", "gmx.net",
  "fastmail.com", "hey.com", "posteo.de", "mailbox.org",
  "example.com", "example.org",
]);

// Deterministic hash for an email string
function emailHash(email: string): number {
  let hash = 0;
  for (let i = 0; i < email.length; i++) {
    hash = email.charCodeAt(i) + ((hash << 5) - hash);
  }
  return Math.abs(hash);
}

// Dev-only: common first names to infer gender for demo portrait selection
const FEMALE_NAMES: Set<string> = IS_DEV ? new Set([
  "alice", "emily", "sarah", "priya", "carol", "anna", "maria", "emma", "olivia",
  "sophia", "isabella", "mia", "charlotte", "amelia", "harper", "ella", "grace",
  "chloe", "luna", "lily", "zoey", "hannah", "nora", "riley", "elena", "maya",
  "claire", "victoria", "natalie", "rachel", "jessica", "jennifer", "lisa",
  "karen", "nancy", "betty", "sandra", "ashley", "margaret", "dorothy",
  "julia", "laura", "susan", "andrea", "diana", "marie", "sophie",
]) : new Set();

const MALE_NAMES: Set<string> = IS_DEV ? new Set([
  "bob", "marcus", "alex", "david", "james", "john", "robert", "michael",
  "william", "richard", "joseph", "thomas", "charles", "daniel", "matthew",
  "anthony", "mark", "steven", "paul", "andrew", "kevin", "brian", "george",
  "timothy", "jason", "ryan", "jacob", "gary", "eric", "peter", "frank",
  "samuel", "benjamin", "henry", "patrick", "jack", "noah", "liam", "oliver",
  "lucas", "ethan", "mason", "logan", "leo", "max", "oscar", "hugo",
]) : new Set();

function inferGender(name: string | undefined, hash: number): "women" | "men" {
  if (name) {
    const firstName = name.trim().split(/\s+/)[0].toLowerCase();
    if (FEMALE_NAMES.has(firstName)) return "women";
    if (MALE_NAMES.has(firstName)) return "men";
  }
  return hash % 2 === 0 ? "women" : "men";
}

// Dev-only: custom avatar URLs for specific demo senders
const CUSTOM_AVATARS: Record<string, string> = IS_DEV ? {
  "newsletter@launchweekly.com": "https://img.freepik.com/premium-vector/swoosh-letter-lw-logo-design-business-company-identity-water-wave-lw-logo-with-modern-trendy_754537-799.jpg?w=360",
  "hello@launchpad.example": "https://img.freepik.com/premium-vector/swoosh-letter-lw-logo-design-business-company-identity-water-wave-lw-logo-with-modern-trendy_754537-799.jpg?w=360",
  "news@techdigest.example": "https://img.freepik.com/premium-vector/technology-letter-t-logo-design-template_125964-1249.jpg?w=360",
  "alice@example.com": "https://randomuser.me/api/portraits/thumb/women/44.jpg",
  "bob@example.org": "https://randomuser.me/api/portraits/thumb/men/32.jpg",
  "carol@example.com": "https://randomuser.me/api/portraits/thumb/women/68.jpg",
} : {};

// Dev-only: for personal-domain emails, deterministically pick a randomuser.me portrait.
// Returns null for ~30% of addresses so not everyone has a photo.
function getProfilePictureUrl(email: string, domain: string, name?: string): string | null {
  if (!IS_DEV) return null;
  if (!PERSONAL_DOMAINS.has(domain)) return null;
  const h = emailHash(email);
  if (h % 10 < 3) return null; // ~30% get no photo
  const gender = inferGender(name, h);
  const id = h % 100;
  return `https://randomuser.me/api/portraits/thumb/${gender}/${id}.jpg`;
}

interface AvatarProps {
  name?: string;
  email?: string;
  size?: "sm" | "md" | "lg";
  className?: string;
}

export function Avatar({ name, email, size = "md", className }: AvatarProps) {
  const [imgError, setImgError] = useState(false);
  const senderFavicons = useSettingsStore((s) => s.senderFavicons);
  const domain = email?.split("@")[1]?.toLowerCase();
  const domainFailed = domain ? failedFaviconDomains.has(domain) : false;

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

  const profilePic = email && domain ? getProfilePictureUrl(email, domain, name) : null;
  const showFavicon =
    senderFavicons && domain && !PERSONAL_DOMAINS.has(domain) && !imgError && !domainFailed;

  // Priority: custom avatar > profile picture > company favicon > initials
  const customAvatar = email ? CUSTOM_AVATARS[email.toLowerCase()] : null;
  const imgSrc = !imgError && !domainFailed
    ? customAvatar || profilePic || (showFavicon ? `/api/favicon?domain=${encodeURIComponent(domain!)}` : null)
    : (customAvatar || profilePic || null);

  const handleImgError = useCallback(() => {
    setImgError(true);
    // If this was a favicon URL (not a custom avatar or profile pic), remember the domain
    if (domain && !customAvatar && !profilePic) {
      failedFaviconDomains.add(domain);
    }
  }, [domain, customAvatar, profilePic]);

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
      {imgSrc ? (
        <img
          src={imgSrc}
          alt=""
          className="w-full h-full object-cover"
          onError={handleImgError}
        />
      ) : (
        getInitials()
      )}
    </div>
  );
}