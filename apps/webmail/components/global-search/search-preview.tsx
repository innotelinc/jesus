"use client";

import { BookUser, CalendarDays, ExternalLink, FileText, Folder, Repeat } from "lucide-react";
import { useTranslations } from "next-intl";
import { ProEmailView } from "@/components/pro/pro-email-tab-body";
import type { CalendarHit, ContactHit, FileHit, GlobalSearchHit } from "@/lib/global-search/types";
import { getContactDisplayName } from "@/stores/contact-store";
import { useAuthStore } from "@/stores/auth-store";
import { formatFileSize } from "@/lib/utils";

function formatDateTime(iso: string | null): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'full', timeStyle: iso.includes('T') ? 'short' : undefined }).format(date);
}

function OpenButton({ hit, onOpen, label }: { hit: GlobalSearchHit; onOpen: (hit: GlobalSearchHit) => void; label: string }) {
  return (
    <button
      type="button"
      onClick={() => onOpen(hit)}
      className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md border border-border text-xs text-muted-foreground hover:bg-muted hover:text-foreground cursor-pointer"
    >
      <ExternalLink className="w-3.5 h-3.5" />
      {label}
    </button>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="text-sm">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="text-foreground break-words">{children}</dd>
    </div>
  );
}

function ContactPreview({ hit, onOpen, openLabel }: { hit: ContactHit; onOpen: (hit: GlobalSearchHit) => void; openLabel: string }) {
  const contact = hit.contact;
  const name = getContactDisplayName(contact) || hit.title;
  const emails = Object.values(contact.emails ?? {}).map((e) => e.address).filter(Boolean);
  const phones = Object.values(contact.phones ?? {}).map((p) => (p as { number?: string }).number).filter(Boolean);
  const orgs = Object.values(contact.organizations ?? {}).map((o) => (o as { name?: string }).name).filter(Boolean);
  return (
    <div className="p-4 flex flex-col gap-3">
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-3 min-w-0">
          <BookUser className="w-8 h-8 shrink-0 text-muted-foreground" />
          <div className="min-w-0">
            <h2 className="text-base font-semibold text-foreground truncate">{name}</h2>
            <p className="text-xs text-muted-foreground truncate">{[hit.accountLabel, hit.subtitle].filter(Boolean).join(' · ')}</p>
          </div>
        </div>
        <OpenButton hit={hit} onOpen={onOpen} label={openLabel} />
      </div>
      <dl className="flex flex-col gap-2">
        {emails.map((email) => <Field key={email} label="@">{email}</Field>)}
        {phones.map((phone) => <Field key={phone} label="#">{phone}</Field>)}
        {orgs.map((org) => <Field key={org} label="">{org}</Field>)}
      </dl>
    </div>
  );
}

function CalendarPreview({ hit, onOpen, openLabel, t }: { hit: CalendarHit; onOpen: (hit: GlobalSearchHit) => void; openLabel: string; t: ReturnType<typeof useTranslations> }) {
  const event = hit.event;
  const locations = Object.values(event.locations ?? {}).map((l) => l?.name).filter(Boolean);
  const participants = Object.values(event.participants ?? {})
    .map((p) => (p as { name?: string | null; email?: string | null }))
    .map((p) => p.name || p.email)
    .filter(Boolean);
  return (
    <div className="p-4 flex flex-col gap-3">
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-3 min-w-0">
          <CalendarDays className="w-8 h-8 shrink-0 text-muted-foreground" />
          <div className="min-w-0">
            <h2 className="flex items-center gap-1.5 text-base font-semibold text-foreground">
              <span className="truncate">{hit.title}</span>
              {hit.isRecurring && <Repeat aria-label={t('recurring')} className="w-3.5 h-3.5 shrink-0 text-muted-foreground" />}
            </h2>
            <p className="text-xs text-muted-foreground truncate">{[hit.accountLabel, hit.subtitle].filter(Boolean).join(' · ')}</p>
          </div>
        </div>
        <OpenButton hit={hit} onOpen={onOpen} label={openLabel} />
      </div>
      <dl className="flex flex-col gap-2">
        <Field label="">{formatDateTime(event.start)}</Field>
        {locations.map((location) => <Field key={location} label="">{location}</Field>)}
        {event.description && <Field label="">{event.description}</Field>}
        {participants.length > 0 && <Field label="">{participants.join(', ')}</Field>}
      </dl>
    </div>
  );
}

function FilePreview({ hit, onOpen, openLabel }: { hit: FileHit; onOpen: (hit: GlobalSearchHit) => void; openLabel: string }) {
  const Icon = hit.isFolder ? Folder : FileText;
  return (
    <div className="p-4 flex flex-col gap-3">
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-3 min-w-0">
          <Icon className="w-8 h-8 shrink-0 text-muted-foreground" />
          <div className="min-w-0">
            <h2 className="text-base font-semibold text-foreground truncate">{hit.title}</h2>
            <p className="text-xs text-muted-foreground truncate">{[hit.accountLabel, hit.folderPath].filter(Boolean).join(' · ')}</p>
          </div>
        </div>
        <OpenButton hit={hit} onOpen={onOpen} label={openLabel} />
      </div>
      <dl className="flex flex-col gap-2">
        {!hit.isFolder && <Field label="">{formatFileSize(hit.node.size)}{hit.node.type ? ` · ${hit.node.type}` : ''}</Field>}
        {hit.date && <Field label="">{formatDateTime(hit.date)}</Field>}
      </dl>
    </div>
  );
}

export interface SearchPreviewProps {
  hit: GlobalSearchHit | null;
  onOpen: (hit: GlobalSearchHit) => void;
  /** Called when the mail view's close affordance is used - clears the selection. */
  onClose: () => void;
}

/** Preview pane of the search tab: full mail view, summary card for the rest. */
export function SearchPreview({ hit, onOpen, onClose }: SearchPreviewProps) {
  const t = useTranslations('global_search');
  const getClientForAccount = useAuthStore((s) => s.getClientForAccount);
  const activeAccountId = useAuthStore((s) => s.activeAccountId);

  if (!hit) {
    return <p className="p-6 text-sm text-muted-foreground text-center">{t('preview_empty')}</p>;
  }

  if (hit.kind === 'mail') {
    const clientOverride = hit.localAccountId !== activeAccountId ? getClientForAccount(hit.localAccountId) ?? undefined : undefined;
    return (
      <ProEmailView
        key={`${hit.localAccountId}-${hit.id}`}
        emailId={hit.id}
        client={clientOverride}
        accountId={hit.jmapAccountId}
        onClose={onClose}
        className="w-full"
      />
    );
  }
  const openLabel = t('open_full');
  if (hit.kind === 'contacts') return <ContactPreview hit={hit} onOpen={onOpen} openLabel={openLabel} />;
  if (hit.kind === 'calendar') return <CalendarPreview hit={hit} onOpen={onOpen} openLabel={openLabel} t={t} />;
  return <FilePreview hit={hit} onOpen={onOpen} openLabel={openLabel} />;
}
