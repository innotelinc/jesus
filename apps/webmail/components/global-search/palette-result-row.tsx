"use client";

import { BookUser, CalendarDays, FileText, Folder, Mail, Repeat } from "lucide-react";
import { useTranslations } from "next-intl";
import { parseSearchSnippet, type SnippetSegment } from "@/lib/search-snippet";
import type { GlobalSearchHit } from "@/lib/global-search/types";
import { cn } from "@/lib/utils";

function HitIcon({ hit }: { hit: GlobalSearchHit }) {
  const className = "w-4 h-4 shrink-0 text-muted-foreground";
  switch (hit.kind) {
    case 'mail': return <Mail className={className} />;
    case 'contacts': return <BookUser className={className} />;
    case 'calendar': return <CalendarDays className={className} />;
    case 'files': return hit.isFolder ? <Folder className={className} /> : <FileText className={className} />;
  }
}

function Snippet({ value }: { value: string }) {
  const segments: SnippetSegment[] = parseSearchSnippet(value);
  return (
    <span className="truncate">
      {segments.map((segment, i) => segment.marked
        ? <mark key={i} className="bg-primary/20 text-foreground rounded-sm px-px">{segment.text}</mark>
        : <span key={i}>{segment.text}</span>)}
    </span>
  );
}

function formatHitDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const sameYear = date.getFullYear() === new Date().getFullYear();
  return new Intl.DateTimeFormat(undefined, sameYear ? { month: 'short', day: 'numeric' } : { year: 'numeric', month: 'short', day: 'numeric' }).format(date);
}

export interface PaletteResultRowProps {
  hit: GlobalSearchHit;
  onOpen: (hit: GlobalSearchHit) => void;
  className?: string;
}

/**
 * One palette hit: icon, title, account · context subtitle, date; the server
 * snippet with its `<mark>`ed terms when mail search returned one.
 */
export function PaletteResultRow({ hit, onOpen, className }: PaletteResultRowProps) {
  const t = useTranslations('global_search');
  const title = hit.title || (hit.kind === 'mail' ? t('no_subject') : hit.id);
  const subtitle = [hit.accountLabel, hit.subtitle].filter(Boolean).join(' · ');
  const snippet = hit.kind === 'mail' && hit.snippet?.preview ? hit.snippet.preview : null;
  return (
    <button
      type="button"
      role="option"
      aria-selected={false}
      onClick={() => onOpen(hit)}
      data-hit-kind={hit.kind}
      className={cn(
        "w-full flex items-start gap-2.5 px-3 py-2 text-left rounded-md",
        "hover:bg-muted focus:bg-muted focus:outline-none",
        className,
      )}
    >
      <span className="mt-0.5"><HitIcon hit={hit} /></span>
      <span className="flex-1 min-w-0">
        <span className="flex items-center gap-1.5 min-w-0">
          <span className="truncate text-sm text-foreground">
            {hit.kind === 'mail' && hit.snippet?.subject ? <Snippet value={hit.snippet.subject} /> : title}
          </span>
          {hit.kind === 'calendar' && hit.isRecurring && (
            <Repeat aria-label={t('recurring')} className="w-3 h-3 shrink-0 text-muted-foreground" />
          )}
        </span>
        <span className="block truncate text-xs text-muted-foreground">{subtitle}</span>
        {snippet && (
          <span className="block truncate text-xs text-muted-foreground"><Snippet value={snippet} /></span>
        )}
      </span>
      {hit.date && (
        <span className="shrink-0 text-xs text-muted-foreground tabular-nums mt-0.5">{formatHitDate(hit.date)}</span>
      )}
    </button>
  );
}
