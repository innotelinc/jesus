"use client";

import { useTranslations } from "next-intl";
import {
  ContextMenu,
  ContextMenuItem,
  ContextMenuSeparator,
} from "@/components/ui/context-menu";
import {
  Pencil,
  Copy,
  Download,
  ClipboardCopy,
  Link as LinkIcon,
  Trash2,
} from "lucide-react";
import type { CalendarEvent } from "@/lib/jmap/types";

interface Position {
  x: number;
  y: number;
}

interface EventContextMenuProps {
  event: CalendarEvent;
  position: Position;
  isOpen: boolean;
  onClose: () => void;
  menuRef: React.RefObject<HTMLDivElement | null>;
  onEdit: () => void;
  onDuplicate: () => void;
  onExportICS: () => void;
  onCopyTitle: () => void;
  onCopyMeetingLink?: () => void;
  onDelete: () => void;
}

export function EventContextMenu({
  event,
  position,
  isOpen,
  onClose,
  menuRef,
  onEdit,
  onDuplicate,
  onExportICS,
  onCopyTitle,
  onCopyMeetingLink,
  onDelete,
}: EventContextMenuProps) {
  const t = useTranslations("calendar");

  const handle = (fn: () => void) => () => {
    fn();
    onClose();
  };

  const hasMeetingLink = !!(
    event.virtualLocations && Object.values(event.virtualLocations).some((v) => v.uri)
  );

  return (
    <ContextMenu ref={menuRef} isOpen={isOpen} position={position} onClose={onClose}>
      <ContextMenuItem icon={Pencil} label={t("events.edit")} onClick={handle(onEdit)} />
      <ContextMenuItem icon={Copy} label={t("events.duplicate")} onClick={handle(onDuplicate)} />
      <ContextMenuSeparator />
      <ContextMenuItem
        icon={Download}
        label={t("events.export_ics")}
        onClick={handle(onExportICS)}
      />
      <ContextMenuItem
        icon={ClipboardCopy}
        label={t("events.copy_title")}
        onClick={handle(onCopyTitle)}
      />
      {hasMeetingLink && onCopyMeetingLink && (
        <ContextMenuItem
          icon={LinkIcon}
          label={t("events.copy_link")}
          onClick={handle(onCopyMeetingLink)}
        />
      )}
      <ContextMenuSeparator />
      <ContextMenuItem
        icon={Trash2}
        label={t("events.delete")}
        onClick={handle(onDelete)}
        destructive
      />
    </ContextMenu>
  );
}
