"use client";

import { useMemo } from "react";
import { useTranslations } from "next-intl";
import { Search, Plus, BookUser, Info } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { ContactListItem } from "./contact-list-item";
import { cn } from "@/lib/utils";
import type { ContactCard } from "@/lib/jmap/types";
import { getContactDisplayName } from "@/stores/contact-store";

interface ContactListProps {
  contacts: ContactCard[];
  selectedContactId: string | null;
  searchQuery: string;
  onSearchChange: (query: string) => void;
  onSelectContact: (id: string) => void;
  onCreateNew: () => void;
  supportsSync: boolean;
  className?: string;
}

export function ContactList({
  contacts,
  selectedContactId,
  searchQuery,
  onSearchChange,
  onSelectContact,
  onCreateNew,
  supportsSync,
  className,
}: ContactListProps) {
  const t = useTranslations("contacts");

  const filtered = useMemo(() => {
    if (!searchQuery) return contacts;
    const lower = searchQuery.toLowerCase();
    return contacts.filter((c) => {
      const name = getContactDisplayName(c).toLowerCase();
      const emails = c.emails
        ? Object.values(c.emails).map((e) => e.address.toLowerCase())
        : [];
      return (
        name.includes(lower) || emails.some((e) => e.includes(lower))
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

  return (
    <div className={cn("flex flex-col h-full", className)}>
      <div className="px-4 py-3 border-b border-border space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">{t("title")}</h2>
          <Button size="sm" onClick={onCreateNew}>
            <Plus className="w-4 h-4 mr-1" />
            {t("create_new")}
          </Button>
        </div>

        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input
            placeholder={t("search_placeholder")}
            value={searchQuery}
            onChange={(e) => onSearchChange(e.target.value)}
            className="pl-9"
          />
        </div>

        {!supportsSync && (
          <div className="flex items-start gap-2 text-xs text-muted-foreground bg-muted rounded px-3 py-2">
            <Info className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
            <span>{t("local_mode")}</span>
          </div>
        )}
      </div>

      <div className="flex-1 overflow-y-auto">
        {sorted.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-muted-foreground px-4">
            <BookUser className="w-12 h-12 mb-3 opacity-30" />
            <p className="text-sm">
              {searchQuery ? t("empty_search") : t("empty_state")}
            </p>
          </div>
        ) : (
          <div className="divide-y divide-border">
            {sorted.map((contact) => (
              <ContactListItem
                key={contact.id}
                contact={contact}
                isSelected={contact.id === selectedContactId}
                onClick={() => onSelectContact(contact.id)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
