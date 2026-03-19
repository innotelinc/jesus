"use client";

import { useMemo, useState, useCallback, type DragEvent } from "react";
import { useTranslations } from "next-intl";
import { BookUser, Users, Plus, UserPlus, Share2, Book } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { ContactCard, AddressBook } from "@/lib/jmap/types";
import { getContactDisplayName } from "@/stores/contact-store";

export type ContactCategory = "all" | { groupId: string } | { addressBookId: string };

interface ContactsSidebarProps {
  groups: ContactCard[];
  individuals: ContactCard[];
  addressBooks: AddressBook[];
  activeCategory: ContactCategory;
  onSelectCategory: (category: ContactCategory) => void;
  onCreateGroup: () => void;
  onCreateContact: () => void;
  onDropContacts?: (contactIds: string[], addressBook: AddressBook) => void;
  className?: string;
}

export function ContactsSidebar({
  groups,
  individuals,
  addressBooks,
  activeCategory,
  onSelectCategory,
  onCreateGroup,
  onCreateContact,
  onDropContacts,
  className,
}: ContactsSidebarProps) {
  const t = useTranslations("contacts");

  const sortedGroups = useMemo(() => {
    return [...groups].sort((a, b) =>
      getContactDisplayName(a).localeCompare(getContactDisplayName(b))
    );
  }, [groups]);

  const isAllActive = activeCategory === "all";

  // Group address books: personal vs shared accounts
  const personalBooks = useMemo(() =>
    addressBooks.filter(b => !b.isShared),
  [addressBooks]);

  const sharedBookGroups = useMemo(() => {
    const map = new Map<string, { accountId: string; accountName: string; books: AddressBook[] }>();
    for (const book of addressBooks) {
      if (!book.isShared || !book.accountId) continue;
      const existing = map.get(book.accountId);
      if (existing) {
        existing.books.push(book);
      } else {
        map.set(book.accountId, {
          accountId: book.accountId,
          accountName: book.accountName || book.accountId,
          books: [book],
        });
      }
    }
    return Array.from(map.values());
  }, [addressBooks]);

  // Count contacts per address book
  const contactCountByBook = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const contact of individuals) {
      if (!contact.addressBookIds) continue;
      for (const bookId of Object.keys(contact.addressBookIds)) {
        if (!contact.addressBookIds[bookId]) continue;
        // Build the full namespaced key
        const key = contact.isShared && contact.accountId ? `${contact.accountId}:${bookId}` : bookId;
        counts[key] = (counts[key] || 0) + 1;
      }
    }
    return counts;
  }, [individuals]);

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
            {individuals.filter(c => !c.isShared).length}
          </span>
        </button>

        {/* Personal address books */}
        {personalBooks.length > 0 && (
          <div className="mt-2">
            <div className="flex items-center justify-between px-3 py-1">
              <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                {t("address_books.title")}
              </span>
            </div>
            {personalBooks.map((book) => (
              <AddressBookItem
                key={book.id}
                book={book}
                isActive={typeof activeCategory === "object" && "addressBookId" in activeCategory && activeCategory.addressBookId === book.id}
                contactCount={contactCountByBook[book.id] || 0}
                onSelect={() => onSelectCategory({ addressBookId: book.id })}
                onDropContacts={onDropContacts}
              />
            ))}
          </div>
        )}

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
              const isActive = typeof activeCategory === "object" && "groupId" in activeCategory && activeCategory.groupId === group.id;
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

        {/* Shared accounts with address books */}
        {sharedBookGroups.map((group) => (
          <div key={group.accountId} className="mt-2">
            <div className="flex items-center justify-between px-3 py-1">
              <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider flex items-center gap-1">
                <Share2 className="w-3 h-3" />
                {group.accountName}
              </span>
            </div>
            {group.books.map((book) => (
              <AddressBookItem
                key={book.id}
                book={book}
                isActive={typeof activeCategory === "object" && "addressBookId" in activeCategory && activeCategory.addressBookId === book.id}
                contactCount={contactCountByBook[book.id] || 0}
                onSelect={() => onSelectCategory({ addressBookId: book.id })}
                onDropContacts={onDropContacts}
              />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

function AddressBookItem({
  book,
  isActive,
  contactCount,
  onSelect,
  onDropContacts,
}: {
  book: AddressBook;
  isActive: boolean;
  contactCount: number;
  onSelect: () => void;
  onDropContacts?: (contactIds: string[], addressBook: AddressBook) => void;
}) {
  const [isDragOver, setIsDragOver] = useState(false);

  const handleDragOver = useCallback((e: DragEvent<HTMLButtonElement>) => {
    if (!e.dataTransfer.types.includes("application/x-contact-ids")) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    setIsDragOver(true);
  }, []);

  const handleDragLeave = useCallback(() => {
    setIsDragOver(false);
  }, []);

  const handleDrop = useCallback((e: DragEvent<HTMLButtonElement>) => {
    e.preventDefault();
    setIsDragOver(false);
    const data = e.dataTransfer.getData("application/x-contact-ids");
    if (!data || !onDropContacts) return;
    try {
      const contactIds = JSON.parse(data) as string[];
      if (contactIds.length > 0) {
        onDropContacts(contactIds, book);
      }
    } catch {
      // ignore invalid data
    }
  }, [book, onDropContacts]);

  return (
    <button
      onClick={onSelect}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      className={cn(
        "w-full flex items-center gap-2 px-3 text-sm transition-colors",
        isActive
          ? "bg-accent text-accent-foreground font-medium"
          : "text-foreground/80 hover:bg-muted",
        isDragOver && "bg-primary/20 ring-2 ring-primary/50"
      )}
      style={{ paddingBlock: 'var(--density-sidebar-py, 4px)', minHeight: '32px' }}
    >
      <Book className="w-4 h-4 flex-shrink-0" />
      <span className="truncate">{book.name}</span>
      <span className="ml-auto text-xs text-muted-foreground tabular-nums">
        {contactCount}
      </span>
    </button>
  );
}
