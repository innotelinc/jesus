"use client";

import { useTranslations } from "next-intl";
import {
  ContextMenu,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuHeader,
} from "@/components/ui/context-menu";
import {
  Eye,
  Pencil,
  Mail,
  ClipboardCopy,
  Download,
  Users,
  Trash2,
} from "lucide-react";
import type { ContactCard } from "@/lib/jmap/types";
import { getContactPrimaryEmail } from "@/stores/contact-store";
import { exportContact } from "./contact-export";
import { toast } from "@/stores/toast-store";

interface Position {
  x: number;
  y: number;
}

interface ContactContextMenuProps {
  contact: ContactCard;
  position: Position;
  isOpen: boolean;
  onClose: () => void;
  menuRef: React.RefObject<HTMLDivElement | null>;
  isMultiSelect?: boolean;
  selectedCount?: number;
  onOpen: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onAddToGroup: () => void;
  onBatchExport?: () => void;
  onBatchAddToGroup?: () => void;
  onBatchDelete?: () => void;
}

export function ContactContextMenu({
  contact,
  position,
  isOpen,
  onClose,
  menuRef,
  isMultiSelect = false,
  selectedCount = 1,
  onOpen,
  onEdit,
  onDelete,
  onAddToGroup,
  onBatchExport,
  onBatchAddToGroup,
  onBatchDelete,
}: ContactContextMenuProps) {
  const t = useTranslations("contacts");
  const email = getContactPrimaryEmail(contact);
  const showBatchActions = isMultiSelect && selectedCount > 1;

  const handle = (fn: () => void) => () => {
    fn();
    onClose();
  };

  const handleSendEmail = () => {
    if (!email) return;
    window.location.href = `mailto:${email}`;
  };

  const handleCopyEmail = async () => {
    if (!email) return;
    try {
      await navigator.clipboard.writeText(email);
      toast.success(t("detail.copied"));
    } catch {
      toast.error(t("detail.copy_failed"));
    }
  };

  const handleExport = () => {
    exportContact(contact);
    toast.success(t("export.success", { count: 1 }));
  };

  if (showBatchActions) {
    return (
      <ContextMenu ref={menuRef} isOpen={isOpen} position={position} onClose={onClose}>
        <ContextMenuHeader>
          {t("bulk.selected", { count: selectedCount })}
        </ContextMenuHeader>
        <ContextMenuItem
          icon={Users}
          label={t("bulk.add_to_group")}
          onClick={handle(() => onBatchAddToGroup?.())}
          disabled={!onBatchAddToGroup}
        />
        <ContextMenuItem
          icon={Download}
          label={t("bulk.export")}
          onClick={handle(() => onBatchExport?.())}
          disabled={!onBatchExport}
        />
        <ContextMenuSeparator />
        <ContextMenuItem
          icon={Trash2}
          label={t("bulk.delete")}
          onClick={handle(() => onBatchDelete?.())}
          disabled={!onBatchDelete}
          destructive
        />
      </ContextMenu>
    );
  }

  return (
    <ContextMenu ref={menuRef} isOpen={isOpen} position={position} onClose={onClose}>
      <ContextMenuItem icon={Eye} label={t("context_menu.open")} onClick={handle(onOpen)} />
      <ContextMenuItem icon={Pencil} label={t("context_menu.edit")} onClick={handle(onEdit)} />
      {email && (
        <>
          <ContextMenuSeparator />
          <ContextMenuItem
            icon={Mail}
            label={t("context_menu.send_email")}
            onClick={handle(handleSendEmail)}
          />
          <ContextMenuItem
            icon={ClipboardCopy}
            label={t("detail.copy_email")}
            onClick={handle(handleCopyEmail)}
          />
        </>
      )}
      <ContextMenuSeparator />
      <ContextMenuItem
        icon={Users}
        label={t("context_menu.add_to_group")}
        onClick={handle(onAddToGroup)}
      />
      <ContextMenuItem
        icon={Download}
        label={t("context_menu.export_vcard")}
        onClick={handle(handleExport)}
      />
      <ContextMenuSeparator />
      <ContextMenuItem
        icon={Trash2}
        label={t("context_menu.delete")}
        onClick={handle(onDelete)}
        destructive
      />
    </ContextMenu>
  );
}
