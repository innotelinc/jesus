"use client";

import { useState, useRef, useEffect } from 'react';
import { useTranslations } from 'next-intl';
import { useEmailStore } from '@/stores/email-store';
import { useAuthStore } from '@/stores/auth-store';
import { useSettingsStore } from '@/stores/settings-store';
import { toast } from '@/stores/toast-store';
import { SettingsSection, SettingItem, Select } from './settings-section';
import {
  Plus, Pencil, Trash2, Check, X, FolderPlus, Folder,
  Inbox, Send, FileText, Trash, ShieldAlert, Archive,
  Star, Heart, Bookmark, Tag, Flag, Briefcase, Users,
  Bell, Zap, Globe, Lock, Eye, MessageSquare, Mail,
  type LucideIcon,
} from 'lucide-react';
import { cn } from '@/lib/utils';

const STANDARD_ROLES = ['inbox', 'drafts', 'sent', 'trash', 'junk', 'archive'] as const;

const ROLE_ICONS: Record<string, LucideIcon> = {
  inbox: Inbox,
  drafts: FileText,
  sent: Send,
  trash: Trash,
  junk: ShieldAlert,
  archive: Archive,
};

const ICON_CHOICES: { name: string; icon: LucideIcon }[] = [
  { name: 'Folder', icon: Folder },
  { name: 'Star', icon: Star },
  { name: 'Heart', icon: Heart },
  { name: 'Bookmark', icon: Bookmark },
  { name: 'Tag', icon: Tag },
  { name: 'Flag', icon: Flag },
  { name: 'Briefcase', icon: Briefcase },
  { name: 'Users', icon: Users },
  { name: 'Bell', icon: Bell },
  { name: 'Zap', icon: Zap },
  { name: 'Globe', icon: Globe },
  { name: 'Lock', icon: Lock },
  { name: 'Eye', icon: Eye },
  { name: 'MessageSquare', icon: MessageSquare },
  { name: 'Mail', icon: Mail },
  { name: 'Inbox', icon: Inbox },
  { name: 'Archive', icon: Archive },
  { name: 'FileText', icon: FileText },
];

function IconPicker({ currentIcon, onSelect, onClose }: {
  currentIcon: string;
  onSelect: (iconName: string) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', handleClick);
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('mousedown', handleClick);
      document.removeEventListener('keydown', handleKey);
    };
  }, [onClose]);

  return (
    <div
      ref={ref}
      className="absolute left-0 top-full mt-1 z-50 bg-background border border-border rounded-lg shadow-lg p-2 grid grid-cols-6 gap-1 w-52"
    >
      {ICON_CHOICES.map(({ name, icon: Icon }) => (
        <button
          key={name}
          onClick={() => onSelect(name)}
          className={cn(
            "p-1.5 rounded-md transition-colors flex items-center justify-center",
            currentIcon === name
              ? "bg-primary text-primary-foreground"
              : "hover:bg-accent text-muted-foreground hover:text-foreground"
          )}
          title={name}
        >
          <Icon className="w-4 h-4" />
        </button>
      ))}
    </div>
  );
}

export function FolderSettings() {
  const t = useTranslations('settings.folders');
  const { client } = useAuthStore();
  const { mailboxes, createMailbox, renameMailbox, deleteMailbox, setMailboxRole } = useEmailStore();
  const { folderIcons, setFolderIcon } = useSettingsStore();

  const [isCreating, setIsCreating] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState('');
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [iconPickerId, setIconPickerId] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  const ownMailboxes = mailboxes.filter(mb => !mb.isShared);

  const getRoleMailboxId = (role: string): string => {
    const mb = ownMailboxes.find(m => m.role === role);
    return mb?.id ?? '';
  };

  const getIconForMailbox = (mb: { id: string; role?: string }): LucideIcon => {
    // Custom icon takes priority for non-role folders
    const customIconName = folderIcons[mb.id];
    if (customIconName) {
      const found = ICON_CHOICES.find(c => c.name === customIconName);
      if (found) return found.icon;
    }
    // Role folders get their role icon
    if (mb.role && ROLE_ICONS[mb.role]) return ROLE_ICONS[mb.role];
    return Folder;
  };

  const getIconName = (mb: { id: string; role?: string }): string => {
    if (folderIcons[mb.id]) return folderIcons[mb.id];
    if (mb.role && ROLE_ICONS[mb.role]) {
      const entry = Object.entries(ROLE_ICONS).find(([r]) => r === mb.role);
      if (entry) {
        const found = ICON_CHOICES.find(c => c.icon === entry[1]);
        if (found) return found.name;
      }
    }
    return 'Folder';
  };

  const handleCreate = async () => {
    if (!client || !newFolderName.trim()) return;
    setIsLoading(true);
    try {
      await createMailbox(client, newFolderName.trim());
      setNewFolderName('');
      setIsCreating(false);
      toast.success(t('folder_created'));
    } catch {
      toast.error(t('error_create'));
    } finally {
      setIsLoading(false);
    }
  };

  const handleRename = async (mailboxId: string) => {
    if (!client || !editingName.trim()) return;
    setIsLoading(true);
    try {
      await renameMailbox(client, mailboxId, editingName.trim());
      setEditingId(null);
      setEditingName('');
      toast.success(t('folder_renamed'));
    } catch {
      toast.error(t('error_rename'));
    } finally {
      setIsLoading(false);
    }
  };

  const handleDelete = async (mailboxId: string) => {
    if (!client) return;
    setIsLoading(true);
    try {
      await deleteMailbox(client, mailboxId);
      setDeletingId(null);
      toast.success(t('folder_deleted'));
    } catch {
      toast.error(t('error_delete'));
    } finally {
      setIsLoading(false);
    }
  };

  const handleRoleChange = async (role: string, mailboxId: string) => {
    if (!client) return;
    setIsLoading(true);
    try {
      if (mailboxId === '') {
        const current = ownMailboxes.find(m => m.role === role);
        if (current) {
          await setMailboxRole(client, current.id, null);
        }
      } else {
        await setMailboxRole(client, mailboxId, role);
      }
      toast.success(t('role_updated'));
    } catch {
      toast.error(t('error_role'));
    } finally {
      setIsLoading(false);
    }
  };

  const startEdit = (mb: { id: string; name: string }) => {
    setEditingId(mb.id);
    setEditingName(mb.name);
  };

  const cancelEdit = () => {
    setEditingId(null);
    setEditingName('');
  };

  const renderFolderRow = (mb: typeof ownMailboxes[0]) => {
    const Icon = getIconForMailbox(mb);

    if (editingId === mb.id) {
      return (
        <div key={mb.id} className="flex items-center gap-2 py-2 px-3">
          <Icon className="w-4 h-4 text-muted-foreground flex-shrink-0" />
          <input
            type="text"
            value={editingName}
            onChange={(e) => setEditingName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleRename(mb.id);
              if (e.key === 'Escape') cancelEdit();
            }}
            className="flex-1 px-2 py-1 text-sm rounded border border-border bg-background text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
            autoFocus
            disabled={isLoading}
          />
          <button
            onClick={() => handleRename(mb.id)}
            disabled={isLoading || !editingName.trim()}
            className="p-1.5 text-primary hover:bg-accent rounded-md disabled:opacity-50"
            title={t('rename')}
          >
            <Check className="w-4 h-4" />
          </button>
          <button
            onClick={cancelEdit}
            className="p-1.5 text-muted-foreground hover:bg-accent rounded-md"
            title={t('cancel')}
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      );
    }

    if (deletingId === mb.id) {
      return (
        <div key={mb.id} className="flex items-center gap-3 py-2.5 px-3 bg-destructive/5 rounded-md border border-destructive/20">
          <Trash2 className="w-4 h-4 text-destructive flex-shrink-0" />
          <p className="text-sm text-foreground flex-1">
            {t('confirm_delete', { name: mb.name })}
          </p>
          <button
            onClick={() => handleDelete(mb.id)}
            disabled={isLoading}
            className="px-3 py-1 text-xs font-medium bg-destructive text-destructive-foreground rounded-md hover:bg-destructive/90 disabled:opacity-50"
          >
            {t('delete')}
          </button>
          <button
            onClick={() => setDeletingId(null)}
            className="px-3 py-1 text-xs bg-muted text-foreground rounded-md hover:bg-accent"
          >
            {t('cancel')}
          </button>
        </div>
      );
    }

    return (
      <div
        key={mb.id}
        className="flex items-center justify-between py-2 px-3 rounded-md hover:bg-muted/50"
      >
        <div className="flex items-center gap-2.5 min-w-0">
          <div className="relative flex-shrink-0">
            <button
              onClick={() => setIconPickerId(iconPickerId === mb.id ? null : mb.id)}
              className={cn(
                "p-1 rounded-md transition-colors",
                iconPickerId === mb.id
                  ? "bg-accent"
                  : "hover:bg-accent"
              )}
              title={t('change_icon')}
            >
              <Icon className={cn(
                "w-4 h-4",
                mb.role ? "text-primary" : "text-muted-foreground"
              )} />
            </button>
            {iconPickerId === mb.id && (
              <IconPicker
                currentIcon={getIconName(mb)}
                onSelect={(iconName) => {
                  setFolderIcon(mb.id, iconName);
                  setIconPickerId(null);
                }}
                onClose={() => setIconPickerId(null)}
              />
            )}
          </div>
          <span className="text-sm text-foreground truncate">{mb.name}</span>
          {mb.role && (
            <span className="text-xs px-1.5 py-0.5 rounded-full bg-primary/10 text-primary font-medium flex-shrink-0">
              {t(`role_${mb.role}`)}
            </span>
          )}
          {mb.unreadEmails > 0 && (
            <span className="text-xs tabular-nums px-1.5 py-0.5 rounded-full bg-primary text-primary-foreground font-medium flex-shrink-0">
              {mb.unreadEmails}
            </span>
          )}
        </div>
        <div className="flex items-center gap-0.5">
          {mb.myRights?.mayRename && (
            <button
              onClick={() => startEdit(mb)}
              className="p-1.5 text-muted-foreground hover:text-foreground hover:bg-accent rounded-md transition-colors"
              title={t('rename')}
            >
              <Pencil className="w-3.5 h-3.5" />
            </button>
          )}
          {mb.myRights?.mayDelete && !mb.role && (
            <button
              onClick={() => setDeletingId(mb.id)}
              className="p-1.5 text-muted-foreground hover:text-destructive hover:bg-destructive/10 rounded-md transition-colors"
              title={t('delete')}
            >
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      </div>
    );
  };

  return (
    <div className="space-y-8">
      {/* Folder List — primary section */}
      <SettingsSection title={t('folder_list')} description={t('folder_list_description')}>
        <div className="space-y-0.5">
          {ownMailboxes.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-8 text-center">
              <Folder className="w-10 h-10 text-muted-foreground/40 mb-3" />
              <p className="text-sm text-muted-foreground">{t('no_folders')}</p>
            </div>
          ) : (
            ownMailboxes.map(renderFolderRow)
          )}
        </div>

        {/* Create folder */}
        {isCreating ? (
          <div className="flex items-center gap-2 mt-3 p-2.5 bg-muted/30 rounded-md border border-border">
            <FolderPlus className="w-4 h-4 text-primary flex-shrink-0" />
            <input
              type="text"
              value={newFolderName}
              onChange={(e) => setNewFolderName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleCreate();
                if (e.key === 'Escape') {
                  setIsCreating(false);
                  setNewFolderName('');
                }
              }}
              placeholder={t('new_folder_name')}
              className="flex-1 px-2 py-1 text-sm rounded border border-border bg-background text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
              autoFocus
              disabled={isLoading}
            />
            <button
              onClick={handleCreate}
              disabled={isLoading || !newFolderName.trim()}
              className="px-3 py-1 text-xs font-medium bg-primary text-primary-foreground rounded-md hover:bg-primary/90 disabled:opacity-50"
            >
              {t('create')}
            </button>
            <button
              onClick={() => {
                setIsCreating(false);
                setNewFolderName('');
              }}
              className="px-3 py-1 text-xs bg-muted text-foreground rounded-md hover:bg-accent"
            >
              {t('cancel')}
            </button>
          </div>
        ) : (
          <button
            onClick={() => setIsCreating(true)}
            className="flex items-center gap-2 mt-3 px-3 py-2 text-sm text-primary hover:bg-primary/5 rounded-md transition-colors w-full border border-dashed border-primary/30 hover:border-primary/50"
          >
            <Plus className="w-4 h-4" />
            {t('create_folder')}
          </button>
        )}
      </SettingsSection>

      {/* Standard Folder Roles — advanced section */}
      <SettingsSection title={t('standard_roles')} description={t('standard_roles_description')}>
        {STANDARD_ROLES.map((role) => (
          <SettingItem key={role} label={t(`role_${role}`)}>
            <Select
              value={getRoleMailboxId(role)}
              onChange={(value) => handleRoleChange(role, value)}
              options={[
                { value: '', label: t('role_none') },
                ...ownMailboxes.map(mb => ({
                  value: mb.id,
                  label: mb.name,
                })),
              ]}
            />
          </SettingItem>
        ))}
      </SettingsSection>
    </div>
  );
}
