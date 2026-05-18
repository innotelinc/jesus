"use client";

import { useTranslations } from "next-intl";
import { Mail, Calendar, BookUser, HardDrive, Settings, PenSquare, MailOpen, X, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ProTab, ProTabKind } from "@/stores/pro-tab-store";

interface ProTabBarProps {
  tabs: ProTab[];
  activeTabId: string;
  onActivate: (id: string) => void;
  onClose: (id: string) => void;
  className?: string;
}

const TAB_ICONS: Record<ProTabKind, LucideIcon> = {
  mail: Mail,
  calendar: Calendar,
  contacts: BookUser,
  files: HardDrive,
  settings: Settings,
  compose: PenSquare,
  email: MailOpen,
};

export function ProTabBar({ tabs, activeTabId, onActivate, onClose, className }: ProTabBarProps) {
  const tSidebar = useTranslations("sidebar");

  return (
    <div
      className={cn(
        "flex items-stretch h-9 bg-secondary px-1 overflow-x-auto scroll-hidden flex-shrink-0",
        className
      )}
      style={{ borderBottom: '1px solid rgba(128, 128, 128, 0.3)' }}
      role="tablist"
    >
      {tabs.map((tab) => {
        const Icon = TAB_ICONS[tab.kind];
        const isActive = tab.id === activeTabId;
        const label = tab.title ?? tSidebar(tab.labelKey);
        return (
          <div
            key={tab.id}
            role="tab"
            aria-selected={isActive}
            onClick={() => onActivate(tab.id)}
            onMouseDown={(e) => {
              // Middle-click closes the tab (when closeable) — matches browser-tab behavior.
              if (e.button === 1 && tab.closeable) {
                e.preventDefault();
                onClose(tab.id);
              }
            }}
            className={cn(
              // Equal-width tabs that grow up to 200px when there's room and
              // shrink down to ~64px when the bar would overflow — matches
              // browser/Thunderbird tab behaviour.
              "group relative flex items-center gap-1.5 px-3 h-9 text-sm cursor-pointer select-none transition-colors",
              "min-w-0 flex-1 basis-0 max-w-[200px] [min-width:80px]",
              "border-r border-border first:border-l",
              isActive
                ? "bg-background text-foreground font-medium"
                : "text-muted-foreground hover:bg-muted hover:text-foreground"
            )}
            style={
              isActive
                ? { borderRightColor: 'rgba(128, 128, 128, 0.3)', borderLeftColor: 'rgba(128, 128, 128, 0.3)' }
                : undefined
            }
          >
            <Icon className={cn("w-4 h-4 flex-shrink-0", isActive && "text-primary")} />
            <span className="truncate flex-1 min-w-0" title={label}>{label}</span>

            {tab.closeable && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onClose(tab.id);
                }}
                className={cn(
                  "ml-1 flex items-center justify-center w-4 h-4 rounded-sm transition-colors flex-shrink-0",
                  "text-muted-foreground hover:bg-muted-foreground/20 hover:text-foreground",
                  !isActive && "opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                )}
                aria-label={tSidebar("close") /* falls back gracefully if missing */}
                tabIndex={isActive ? 0 : -1}
              >
                <X className="w-3 h-3" />
              </button>
            )}

            {isActive && (
              <span
                className="absolute left-0 right-0 -bottom-px h-px bg-background"
                aria-hidden="true"
              />
            )}
          </div>
        );
      })}
    </div>
  );
}
