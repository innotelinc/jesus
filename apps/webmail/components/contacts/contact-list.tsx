"use client";

import { useMemo } from "react";
import { useTranslations } from "next-intl";
import { Search, BookUser, Trash2, Users, Download, X, UserPlus, CheckSquare, Square } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { ContactListItem } from "./contact-list-item";
import { cn } from "@/lib/utils";
import type { ContactCard } from "@/lib/jmap/types";
import { getContactDisplayName } from "@/stores/contact-store";
import { useSettingsStore } from "@/stores/settings-store";

interface ContactListProps {
  contacts: ContactCard[];
  selectedContactId: string | null;
  searchQuery: string;
  onSearchChange: (query: string) => void;
  onSelectContact: (id: string) => void;
  onCreateNew: () => void;
  categoryLabel: string;
  className?: string;
  selectedContactIds: Set<string>;
  onToggleSelection: (id: string) => void;
  onSelectRangeContacts: (id: string, sortedIds: string[]) => void;
  onSelectAll: (ids: string[]) => void;
  onClearSelection: () => void;
  onBulkDelete: () => void;
  onBulkAddToGroup: () => void;
  onBulkExport: () => void;
}

export function ContactList({
  contacts,
  selectedContactId,
  searchQuery,
  onSearchChange,
  onSelectContact,
  onCreateNew,
  categoryLabel,
  className,
  selectedContactIds,
  onToggleSelection,
  onSelectRangeContacts,
  onSelectAll,
  onClearSelection,
  onBulkDelete,
  onBulkAddToGroup,
  onBulkExport,
}: ContactListProps) {
  const t = useTranslations("contacts");
  const density = useSettingsStore((state) => state.density);

  const filtered = useMemo(() => {
    if (!searchQuery) return contacts;
    const lower = searchQuery.toLowerCase();
    return contacts.filter((c) => {
      const name = getContactDisplayName(c).toLowerCase();
      const emails = c.emails
        ? Object.values(c.emails).map((e) => e.address.toLowerCase())
        : [];
      const phones = c.phones
        ? Object.values(c.phones).map((p) => p.number?.toLowerCase() || "")
        : [];
      const org = c.organizations
        ? Object.values(c.organizations).map((o) => o.name?.toLowerCase() || "")
        : [];
      return (
        name.includes(lower) ||
        emails.some((e) => e.includes(lower)) ||
        phones.some((p) => p.includes(lower)) ||
        org.some((o) => o.includes(lower))
      );
    });
  }, [contacts, searchQuery]);

  const sorted = useMemo(() => {
    return [...filtered].sort((a, b) => {
      const nameA = getContactDisplayName(a).toLowerCase();
      const nameB = getContactDisplayName(b).toLowerCase();
      return nameA.localeCompare(nameB);
    });
  }, [filtered]);

  const sortedIds = useMemo(() => sorted.map(c => c.id), [sorted]);

  const hasSelection = selectedContactIds.size > 0;
  const allSelected = sorted.length > 0 && sorted.every(c => selectedContactIds.has(c.id));

  return (
    <div className={cn("flex flex-col h-full", className)}>
      {/* Search header */}
      <div className="px-3 border-b border-border space-y-1.5" style={{ paddingBlock: 'var(--density-header-py)' }}>
        <div className="flex items-center justify-between">
          <span className="text-xs font-medium text-muted-foreground truncate">
            {categoryLabel} ({contacts.length})
          </span>
        </div>
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
          <Input
            placeholder={t("search_placeholder")}
            value={searchQuery}
            onChange={(e) => onSearchChange(e.target.value)}
            className="pl-8 h-8 text-sm"
          />
        </div>
      </div>

      {/* Bulk action bar */}
      {hasSelection && (
        <div className="px-3 py-1.5 border-b border-border bg-accent/30 flex items-center gap-2 flex-wrap">
          <button
            onClick={() => {
              if (allSelected) {
                onClearSelection();
              } else {
                onSelectAll(sortedIds);
              }
            }}
            className="p-1 rounded hover:bg-muted/50 transition-colors"
          >
            {allSelected ? (
              <CheckSquare className="w-4 h-4 text-primary" />
            ) : (
              <Square className="w-4 h-4 text-muted-foreground" />
            )}
          </button>
          <span className="text-xs font-medium text-foreground">
            {t("bulk.selected", { count: selectedContactIds.size })}
          </span>
          <div className="flex-1" />
          <Button variant="ghost" size="sm" onClick={onBulkAddToGroup} className="h-7 text-xs">
            <Users className="w-3.5 h-3.5 mr-1" />
            {t("bulk.add_to_group")}
          </Button>
          <Button variant="ghost" size="sm" onClick={onBulkExport} className="h-7 text-xs">
            <Download className="w-3.5 h-3.5 mr-1" />
            {t("bulk.export")}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={onBulkDelete}
            className="h-7 text-xs text-red-600 dark:text-red-400 hover:text-red-700 dark:hover:text-red-300"
          >
            <Trash2 className="w-3.5 h-3.5 mr-1" />
            {t("bulk.delete")}
          </Button>
          <Button variant="ghost" size="icon" onClick={onClearSelection} className="h-7 w-7">
            <X className="w-3.5 h-3.5" />
          </Button>
        </div>
      )}

      {/* Contact list */}
      <div className="flex-1 overflow-y-auto">
        {sorted.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full px-6 text-center">
            {searchQuery ? (
              <>
                <Search className="w-10 h-10 mb-3 text-muted-foreground/30" />
                <p className="text-sm font-medium text-foreground">{t("empty_search")}</p>
                <p className="text-xs text-muted-foreground mt-1">{t("empty_search_hint")}</p>
                <Button
                  variant="outline"
                  size="sm"
                  className="mt-3"
                  onClick={() => onSearchChange("")}
                >
                  {t("clear_search")}
                </Button>
              </>
            ) : (
              <>
                <BookUser className="w-10 h-10 mb-3 text-muted-foreground/30" />
                <p className="text-sm font-medium text-foreground">{t("empty_state_title")}</p>
                <p className="text-xs text-muted-foreground mt-1">{t("empty_state_subtitle")}</p>
                <Button size="sm" className="mt-3" onClick={onCreateNew}>
                  <UserPlus className="w-4 h-4 mr-1.5" />
                  {t("create_new")}
                </Button>
              </>
            )}
          </div>
        ) : (
          <div>
            {sorted.map((contact) => (
              <ContactListItem
                key={contact.id}
                contact={contact}
                isSelected={contact.id === selectedContactId}
                isChecked={selectedContactIds.has(contact.id)}
                hasSelection={hasSelection}
                density={density}
                selectedContactIds={selectedContactIds}
                onClick={(e) => {
                  if (e.ctrlKey || e.metaKey) {
                    e.preventDefault();
                    onToggleSelection(contact.id);
                  } else if (e.shiftKey) {
                    e.preventDefault();
                    onSelectRangeContacts(contact.id, sortedIds);
                  } else {
                    if (hasSelection) onClearSelection();
                    onSelectContact(contact.id);
                  }
                }}
                onCheckboxClick={(e) => {
                  e.stopPropagation();
                  onToggleSelection(contact.id);
                }}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
