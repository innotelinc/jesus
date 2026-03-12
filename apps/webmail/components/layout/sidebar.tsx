"use client";

import { useState, useEffect } from "react";
import { useTranslations } from "next-intl";
import { useRouter } from "@/i18n/navigation";
import { Button } from "@/components/ui/button";
import {
  Inbox,
  Send,
  File,
  Star,
  Trash2,
  Archive,
  PenSquare,
  ChevronsLeft,
  ChevronsRight,
  ChevronRight,
  ChevronDown,
  Folder,
  FolderOpen,
  Users,
  User,
  Palmtree,
  Settings,
  X,
  Tag,
} from "lucide-react";
import { cn, buildMailboxTree, MailboxNode } from "@/lib/utils";
import { Mailbox } from "@/lib/jmap/types";
import { useDragDropContext } from "@/contexts/drag-drop-context";
import { useMailboxDrop } from "@/hooks/use-mailbox-drop";
import { useTagDrop } from "@/hooks/use-tag-drop";
import { useUIStore } from "@/stores/ui-store";
import { useAuthStore } from "@/stores/auth-store";
import { useVacationStore } from "@/stores/vacation-store";
import { useSettingsStore, KEYWORD_PALETTE, KeywordDefinition } from "@/stores/settings-store";
import { toast } from "@/stores/toast-store";
import { debug } from "@/lib/debug";

interface SidebarProps {
  mailboxes: Mailbox[];
  selectedMailbox?: string;
  selectedKeyword?: string | null;
  onMailboxSelect?: (mailboxId: string) => void;
  onTagSelect?: (keywordId: string | null) => void;
  onCompose?: () => void;
  onSidebarClose?: () => void;
  className?: string;
}

const getIconForMailbox = (role?: string, name?: string, hasChildren?: boolean, isExpanded?: boolean, isShared?: boolean, id?: string) => {
  const lowerName = name?.toLowerCase() || "";

  if (id === 'shared-folders-root') {
    return isExpanded ? FolderOpen : Users;
  }

  if (id?.startsWith('shared-account-')) {
    return isExpanded ? FolderOpen : User;
  }

  if (isShared && hasChildren && !id?.startsWith('shared-')) {
    return isExpanded ? FolderOpen : Folder;
  }

  if (hasChildren) {
    return isExpanded ? FolderOpen : Folder;
  }

  if (role === "inbox" || lowerName.includes("inbox")) return Inbox;
  if (role === "sent" || lowerName.includes("sent")) return Send;
  if (role === "drafts" || lowerName.includes("draft")) return File;
  if (role === "trash" || lowerName.includes("trash")) return Trash2;
  if (role === "archive" || lowerName.includes("archive")) return Archive;
  if (lowerName.includes("star") || lowerName.includes("flag")) return Star;
  return Inbox;
};

function MailboxTreeItem({
  node,
  selectedMailbox,
  expandedFolders,
  onMailboxSelect,
  onToggleExpand,
  isCollapsed,
}: {
  node: MailboxNode;
  selectedMailbox: string;
  expandedFolders: Set<string>;
  onMailboxSelect?: (id: string) => void;
  onToggleExpand: (id: string) => void;
  isCollapsed: boolean;
}) {
  const t = useTranslations('sidebar');
  const tNotifications = useTranslations('notifications');
  const hasChildren = node.children.length > 0;
  const isExpanded = expandedFolders.has(node.id);
  const Icon = getIconForMailbox(node.role, node.name, hasChildren, isExpanded, node.isShared, node.id);
  const indentPixels = node.depth * 16;
  const isVirtualNode = node.id.startsWith('shared-');

  const { isDragging: globalDragging } = useDragDropContext();
  const { dropHandlers, isValidDropTarget, isInvalidDropTarget } = useMailboxDrop({
    mailbox: node,
    onSuccess: (count, mailboxName) => {
      if (count === 1) {
        toast.success(
          tNotifications('email_moved'),
          tNotifications('moved_to_mailbox', { mailbox: mailboxName })
        );
      } else {
        toast.success(
          tNotifications('emails_moved', { count }),
          tNotifications('moved_to_mailbox', { mailbox: mailboxName })
        );
      }
    },
    onError: () => {
      toast.error(tNotifications('move_failed'), tNotifications('move_error'));
    },
  });

  return (
    <>
      <div
        {...(globalDragging ? dropHandlers : {})}
        className={cn(
          "group w-full flex items-center py-1 lg:py-1 max-lg:py-3 max-lg:min-h-[44px] text-sm transition-all duration-200",
          isCollapsed ? "justify-center px-1" : "px-2",
          isVirtualNode
            ? "text-muted-foreground"
            : selectedMailbox === node.id
              ? "bg-accent text-accent-foreground"
              : "hover:bg-muted text-foreground",
          node.depth === 0 && !isVirtualNode && "font-medium",
          isValidDropTarget && "bg-primary/20 ring-2 ring-primary ring-inset",
          isInvalidDropTarget && "bg-destructive/10 ring-2 ring-destructive/30 ring-inset opacity-50"
        )}
      >
        {hasChildren && !isCollapsed && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onToggleExpand(node.id);
            }}
            className={cn(
              "p-0.5 rounded mr-1 transition-all duration-200",
              "hover:bg-muted active:bg-accent"
            )}
            style={{ marginLeft: indentPixels }}
            title={isExpanded ? t('collapse_tooltip') : t('expand_tooltip')}
          >
            {isExpanded ? (
              <ChevronDown className="w-3 h-3 text-muted-foreground" />
            ) : (
              <ChevronRight className="w-3 h-3 text-muted-foreground" />
            )}
          </button>
        )}

        <button
          onClick={() => !isVirtualNode && onMailboxSelect?.(node.id)}
          disabled={isVirtualNode}
          className={cn(
            "flex items-center py-1 lg:py-1 max-lg:py-2 px-1 rounded",
            "transition-colors duration-150",
            isCollapsed ? "justify-center" : "flex-1 text-left",
            isVirtualNode && "cursor-default select-none"
          )}
          style={isCollapsed ? undefined : {
            paddingLeft: hasChildren ? '4px' : `${indentPixels + 24}px`
          }}
          title={isCollapsed ? node.name : undefined}
        >
          <Icon className={cn(
            "w-4 h-4 flex-shrink-0 transition-colors",
            !isCollapsed && "mr-2",
            hasChildren && isExpanded && "text-primary",
            selectedMailbox === node.id && "text-accent-foreground",
            !hasChildren && node.depth > 0 && "text-muted-foreground",
            node.isShared && "text-blue-500"
          )} />
          {!isCollapsed && (
            <>
              <span className="flex-1 truncate">{node.name}</span>
              <span className="flex items-center gap-1.5 ml-2 flex-shrink-0">
                {node.unreadEmails > 0 && (
                  <span className={cn(
                    "text-xs rounded-full px-2 py-0.5 font-medium",
                    selectedMailbox === node.id
                      ? "bg-primary text-primary-foreground"
                      : "bg-foreground text-background"
                  )}>
                    {node.unreadEmails}
                  </span>
                )}
                <span className="text-xs text-muted-foreground tabular-nums">
                  {node.totalEmails}
                </span>
              </span>
            </>
          )}
        </button>
      </div>

      {hasChildren && isExpanded && !isCollapsed && (
        <div className="relative">
          {node.children.map((child) => (
            <MailboxTreeItem
              key={child.id}
              node={child}
              selectedMailbox={selectedMailbox}
              expandedFolders={expandedFolders}
              onMailboxSelect={onMailboxSelect}
              onToggleExpand={onToggleExpand}
              isCollapsed={isCollapsed}
            />
          ))}
        </div>
      )}
    </>
  );
}

function TagItem({
  kw,
  isSelected,
  isCollapsed,
  onTagSelect,
}: {
  kw: KeywordDefinition;
  isSelected: boolean;
  isCollapsed: boolean;
  onTagSelect?: (keywordId: string | null) => void;
}) {
  const t = useTranslations('notifications');
  const palette = KEYWORD_PALETTE[kw.color];
  const { isDragging: globalDragging } = useDragDropContext();
  const { dropHandlers, isValidDropTarget } = useTagDrop({
    tagId: kw.id,
    onSuccess: (count, _tagLabel) => {
      if (count === 1) {
        toast.success(t('email_tagged'), kw.label);
      } else {
        toast.success(t('emails_tagged', { count }), kw.label);
      }
    },
    onError: () => {
      toast.error(t('tag_failed'), kw.label);
    },
  });

  return (
    <div
      {...(globalDragging ? dropHandlers : {})}
      className={cn(
        "group w-full flex items-center py-1 lg:py-1 max-lg:py-3 max-lg:min-h-[44px] text-sm transition-all duration-200",
        isCollapsed ? "justify-center px-1" : "px-2",
        isSelected
          ? "bg-accent text-accent-foreground"
          : "hover:bg-muted text-foreground",
        isValidDropTarget && "bg-primary/20 ring-2 ring-primary ring-inset"
      )}
    >
      <button
        onClick={() => onTagSelect?.(isSelected ? null : kw.id)}
        className={cn(
          "flex items-center py-1 lg:py-1 max-lg:py-2 px-1 rounded transition-colors duration-150",
          isCollapsed ? "justify-center" : "flex-1 text-left"
        )}
        style={isCollapsed ? undefined : { paddingLeft: '40px' }}
        title={isCollapsed ? kw.label : undefined}
      >
        <span className={cn("w-3 h-3 rounded-full flex-shrink-0", palette?.dot || "bg-gray-400", !isCollapsed && "mr-2")} />
        {!isCollapsed && <span className="truncate">{kw.label}</span>}
      </button>
    </div>
  );
}

function VacationBanner() {
  const t = useTranslations('sidebar');
  const router = useRouter();
  const { isEnabled, isSupported } = useVacationStore();

  if (!isSupported || !isEnabled) return null;

  return (
    <button
      onClick={() => router.push('/settings')}
      className={cn(
        "flex items-center gap-2 w-full px-3 py-2 text-xs",
        "bg-amber-500/10 dark:bg-amber-400/10 text-amber-700 dark:text-amber-400",
        "hover:bg-amber-500/15 dark:hover:bg-amber-400/15 transition-colors"
      )}
    >
      <Palmtree className="w-3.5 h-3.5 flex-shrink-0" />
      <span className="truncate font-medium">{t("vacation_active")}</span>
      <Settings className="w-3 h-3 ml-auto flex-shrink-0 opacity-60" />
    </button>
  );
}

export function Sidebar({
  mailboxes = [],
  selectedMailbox = "",
  selectedKeyword = null,
  onMailboxSelect,
  onTagSelect,
  onCompose,
  onSidebarClose,
  className,
}: SidebarProps) {
  const { sidebarCollapsed: isCollapsed, toggleSidebarCollapsed } = useUIStore();
  const { primaryIdentity } = useAuthStore();
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set());
  const [tagsExpanded, setTagsExpanded] = useState(() => {
    try {
      const stored = localStorage.getItem('sidebarTagsExpanded');
      return stored !== null ? JSON.parse(stored) : true;
    } catch { return true; }
  });
  const emailKeywords = useSettingsStore(s => s.emailKeywords);
  const t = useTranslations('sidebar');

  useEffect(() => {
    const stored = localStorage.getItem('expandedMailboxes');
    if (stored) {
      try {
        const parsed = JSON.parse(stored);
        setExpandedFolders(new Set(parsed));
      } catch (e) {
        debug.error('Failed to parse expanded mailboxes:', e);
      }
    } else {
      const tree = buildMailboxTree(mailboxes);
      const defaultExpanded = tree
        .filter(node => node.children.length > 0)
        .map(node => node.id);
      setExpandedFolders(new Set(defaultExpanded));
    }
  }, [mailboxes]);

  const handleToggleExpand = (mailboxId: string) => {
    setExpandedFolders((prev) => {
      const next = new Set(prev);
      if (next.has(mailboxId)) {
        next.delete(mailboxId);
      } else {
        next.add(mailboxId);
      }
      try {
        localStorage.setItem('expandedMailboxes', JSON.stringify(Array.from(next)));
      } catch { /* storage full or unavailable */ }
      return next;
    });
  };

  const mailboxTree = buildMailboxTree(mailboxes);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!selectedMailbox || isCollapsed) return;

      const findNode = (nodes: MailboxNode[]): MailboxNode | null => {
        for (const node of nodes) {
          if (node.id === selectedMailbox) return node;
          const found = findNode(node.children);
          if (found) return found;
        }
        return null;
      };

      const selectedNode = findNode(mailboxTree);
      if (!selectedNode) return;

      if (e.key === 'ArrowRight' && selectedNode.children.length > 0) {
        if (!expandedFolders.has(selectedMailbox)) {
          handleToggleExpand(selectedMailbox);
        }
      } else if (e.key === 'ArrowLeft' && selectedNode.children.length > 0) {
        if (expandedFolders.has(selectedMailbox)) {
          handleToggleExpand(selectedMailbox);
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [selectedMailbox, isCollapsed, expandedFolders, mailboxTree]);

  return (
    <div
      className={cn(
        "relative flex flex-col h-full border-r transition-all duration-300 overflow-hidden",
        "bg-secondary border-border",
        "max-lg:w-full",
        isCollapsed ? "lg:w-12" : "lg:w-full",
        className
      )}
    >
      {/* Header */}
      <div className={cn("flex items-center border-b border-border", isCollapsed ? "justify-center px-2 py-3" : "gap-2 px-4 py-3")}>
        <Button
          variant="ghost"
          size="icon"
          onClick={onSidebarClose}
          className="lg:hidden h-11 w-11 flex-shrink-0"
          aria-label={t("close")}
        >
          <X className="w-5 h-5" />
        </Button>

        <Button
          variant="ghost"
          size="icon"
          onClick={toggleSidebarCollapsed}
          className="hidden lg:flex flex-shrink-0"
          title={isCollapsed ? t("expand_tooltip") : t("collapse_tooltip")}
        >
          {isCollapsed ? <ChevronsRight className="w-4 h-4" /> : <ChevronsLeft className="w-4 h-4" />}
        </Button>

        {!isCollapsed && primaryIdentity && (
          <div className="min-w-0">
            <p className="text-sm font-medium text-foreground truncate" title={primaryIdentity.name}>
              {primaryIdentity.name}
            </p>
            <p className="text-xs text-muted-foreground truncate" title={primaryIdentity.email}>
              {primaryIdentity.email}
            </p>
          </div>
        )}
      </div>

      {/* Vacation Banner */}
      {!isCollapsed && <VacationBanner />}

      {/* Mailbox List */}
      <div className="flex-1 overflow-y-auto">
        <div className="py-1">
          {mailboxes.length === 0 ? (
            <div className="px-4 py-2 text-sm text-muted-foreground">
              {!isCollapsed && t("loading_mailboxes")}
            </div>
          ) : (
            <>
              {mailboxTree.map((node) => (
                <MailboxTreeItem
                  key={node.id}
                  node={node}
                  selectedMailbox={selectedKeyword ? "" : selectedMailbox}
                  expandedFolders={expandedFolders}
                  onMailboxSelect={onMailboxSelect}
                  onToggleExpand={handleToggleExpand}
                  isCollapsed={isCollapsed}
                />
              ))}
            </>
          )}
        </div>

        {/* Tags Section */}
        {emailKeywords.length > 0 && (
          <>
            <div
              className={cn(
                "group w-full flex items-center py-1 lg:py-1 max-lg:py-3 max-lg:min-h-[44px] text-sm transition-all duration-200 font-medium",
                isCollapsed ? "justify-center px-1" : "px-2",
                "text-foreground hover:bg-muted"
              )}
            >
              {!isCollapsed && (
                <button
                  onClick={() => {
                    setTagsExpanded((prev: boolean) => {
                      const next = !prev;
                      try { localStorage.setItem('sidebarTagsExpanded', JSON.stringify(next)); } catch { /* */ }
                      return next;
                    });
                  }}
                  className={cn(
                    "p-0.5 rounded mr-1 transition-all duration-200",
                    "hover:bg-muted active:bg-accent"
                  )}
                  title={tagsExpanded ? t('collapse_tooltip') : t('expand_tooltip')}
                >
                  {tagsExpanded ? (
                    <ChevronDown className="w-3 h-3 text-muted-foreground" />
                  ) : (
                    <ChevronRight className="w-3 h-3 text-muted-foreground" />
                  )}
                </button>
              )}

              <button
                onClick={() => {
                  if (isCollapsed) return;
                  setTagsExpanded((prev: boolean) => {
                    const next = !prev;
                    try { localStorage.setItem('sidebarTagsExpanded', JSON.stringify(next)); } catch { /* */ }
                    return next;
                  });
                }}
                className={cn(
                  "flex items-center py-1 lg:py-1 max-lg:py-2 px-1 rounded",
                  "transition-colors duration-150",
                  isCollapsed ? "justify-center" : "flex-1 text-left"
                )}
                style={isCollapsed ? undefined : { paddingLeft: '4px' }}
                title={isCollapsed ? t("tags") : undefined}
              >
                <Tag className={cn(
                  "w-4 h-4 flex-shrink-0 transition-colors",
                  !isCollapsed && "mr-2",
                  tagsExpanded && "text-primary"
                )} />
                {!isCollapsed && (
                  <span className="flex-1 truncate">{t("tags")}</span>
                )}
              </button>
            </div>

            {((tagsExpanded && !isCollapsed) || isCollapsed) && (
              <div className="relative">
                {emailKeywords.map((kw) => {
                  const isSelected = selectedKeyword === kw.id;
                  return (
                    <TagItem
                      key={kw.id}
                      kw={kw}
                      isSelected={isSelected}
                      isCollapsed={isCollapsed}
                      onTagSelect={onTagSelect}
                    />
                  );
                })}
              </div>
            )}
          </>
        )}
      </div>

      {/* Compose Button */}
      <div className={cn("border-t border-border", isCollapsed ? "flex justify-center py-3" : "px-3 py-3")}>
        {isCollapsed ? (
          <Button onClick={onCompose} variant="ghost" size="icon" title={t("compose_hint")}>
            <PenSquare className="w-5 h-5" />
          </Button>
        ) : (
          <Button onClick={onCompose} className="w-full" title={t("compose_hint")}>
            <PenSquare className="w-4 h-4 mr-2" />
            {t("compose")}
          </Button>
        )}
      </div>
    </div>
  );
}
