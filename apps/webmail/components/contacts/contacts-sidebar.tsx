"use client";

import { useMemo } from "react";
import { useTranslations } from "next-intl";
import { BookUser, Users, Plus, UserPlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { ContactCard } from "@/lib/jmap/types";
import { getContactDisplayName } from "@/stores/contact-store";

export type ContactCategory = "all" | { groupId: string };

interface ContactsSidebarProps {
  groups: ContactCard[];
  individuals: ContactCard[];
  activeCategory: ContactCategory;
  onSelectCategory: (category: ContactCategory) => void;
  onCreateGroup: () => void;
  onCreateContact: () => void;
  className?: string;
}

export function ContactsSidebar({
  groups,
  individuals,
  activeCategory,
  onSelectCategory,
  onCreateGroup,
  onCreateContact,
  className,
}: ContactsSidebarProps) {
  const t = useTranslations("contacts");

  const sortedGroups = useMemo(() => {
    return [...groups].sort((a, b) =>
      getContactDisplayName(a).localeCompare(getContactDisplayName(b))
    );
  }, [groups]);

  const isAllActive = activeCategory === "all";

  return (
    <div className={cn("flex flex-col h-full bg-secondary", className)}>
      {/* Header */}
      <div className="px-3 border-b border-border flex items-center justify-between" style={{ paddingBlock: 'var(--density-header-py)' }}>
        <span className="text-sm font-semibold truncate">{t("title")}</span>
        <Button size="icon" variant="ghost" onClick={onCreateContact} className="h-7 w-7 flex-shrink-0">
          <UserPlus className="w-4 h-4" />
        </Button>
      </div>

      {/* Categories */}
      <div className="flex-1 overflow-y-auto py-1">
        {/* All contacts */}
        <button
          onClick={() => onSelectCategory("all")}
          className={cn(
            "w-full flex items-center gap-2 px-3 text-sm transition-colors",
            isAllActive
              ? "bg-accent text-accent-foreground font-medium"
              : "text-foreground/80 hover:bg-muted"
          )}
          style={{ paddingBlock: 'var(--density-sidebar-py, 4px)', minHeight: '32px' }}
        >
          <BookUser className="w-4 h-4 flex-shrink-0" />
          <span className="truncate">{t("tabs.all")}</span>
          <span className="ml-auto text-xs text-muted-foreground tabular-nums">
            {individuals.length}
          </span>
        </button>

        {/* Groups section */}
        {(sortedGroups.length > 0) && (
          <div className="mt-2">
            <div className="flex items-center justify-between px-3 py-1">
              <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                {t("tabs.groups")}
              </span>
              <Button size="icon" variant="ghost" onClick={onCreateGroup} className="h-5 w-5">
                <Plus className="w-3 h-3" />
              </Button>
            </div>

            {sortedGroups.map((group) => {
              const isActive = typeof activeCategory === "object" && activeCategory.groupId === group.id;
              const memberCount = group.members
                ? Object.values(group.members).filter(Boolean).length
                : 0;

              return (
                <button
                  key={group.id}
                  onClick={() => onSelectCategory({ groupId: group.id })}
                  className={cn(
                    "w-full flex items-center gap-2 px-3 text-sm transition-colors",
                    isActive
                      ? "bg-accent text-accent-foreground font-medium"
                      : "text-foreground/80 hover:bg-muted"
                  )}
                  style={{ paddingBlock: 'var(--density-sidebar-py, 4px)', minHeight: '32px' }}
                >
                  <Users className="w-4 h-4 flex-shrink-0" />
                  <span className="truncate">{getContactDisplayName(group)}</span>
                  <span className="ml-auto text-xs text-muted-foreground tabular-nums">
                    {memberCount}
                  </span>
                </button>
              );
            })}
          </div>
        )}

        {sortedGroups.length === 0 && (
          <div className="mt-2 px-3">
            <div className="flex items-center justify-between py-1">
              <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                {t("tabs.groups")}
              </span>
            </div>
            <Button
              size="sm"
              variant="ghost"
              onClick={onCreateGroup}
              className="w-full justify-start text-xs text-muted-foreground h-7"
            >
              <Plus className="w-3 h-3 mr-1.5" />
              {t("groups.create")}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
