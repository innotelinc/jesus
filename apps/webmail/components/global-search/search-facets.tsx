"use client";

import { useTranslations } from "next-intl";
import type { SearchScope } from "@/lib/global-search/query-parser";
import { SEARCH_KINDS, type SearchKind } from "@/lib/global-search/types";
import { cn } from "@/lib/utils";

export interface SearchFacetsProps {
  scope: SearchScope;
  onScopeChange: (scope: SearchScope) => void;
  kindCounts: Record<SearchKind, number>;
  /** '+' suffix on the count (the server reported more than was fetched). */
  kindHasMore: Record<SearchKind, boolean>;
  accounts: Array<{ localAccountId: string; label: string; count: number }>;
  accountId: string | null;
  onAccountChange: (accountId: string | null) => void;
  flat: boolean;
  onFlatChange: (flat: boolean) => void;
}

function FacetButton({ active, label, count, onClick }: { active: boolean; label: string; count?: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "w-full flex items-center justify-between gap-2 px-2 py-1 rounded-md text-sm text-left cursor-pointer",
        active ? "bg-primary/10 text-primary font-medium" : "text-muted-foreground hover:bg-muted hover:text-foreground",
      )}
    >
      <span className="truncate">{label}</span>
      {count !== undefined && <span className="shrink-0 text-xs tabular-nums">{count}</span>}
    </button>
  );
}

/** Facet column of the search tab: result kind, account, grouped/flat order. */
export function SearchFacets({
  scope, onScopeChange, kindCounts, kindHasMore,
  accounts, accountId, onAccountChange,
  flat, onFlatChange,
}: SearchFacetsProps) {
  const t = useTranslations('global_search');
  const total = SEARCH_KINDS.reduce((sum, kind) => sum + kindCounts[kind], 0);
  const anyMore = SEARCH_KINDS.some((kind) => kindHasMore[kind]);
  return (
    <div className="flex flex-col gap-4 p-3 overflow-y-auto">
      <section>
        <h3 className="px-2 pb-1 text-xs font-medium text-muted-foreground uppercase tracking-wide">{t('scope_label')}</h3>
        <FacetButton
          active={scope === 'all'}
          label={t('scope_all')}
          count={`${total}${anyMore ? '+' : ''}`}
          onClick={() => onScopeChange('all')}
        />
        {SEARCH_KINDS.map((kind) => (
          <FacetButton
            key={kind}
            active={scope === kind}
            label={t(`scope_${kind}`)}
            count={`${kindCounts[kind]}${kindHasMore[kind] ? '+' : ''}`}
            onClick={() => onScopeChange(kind)}
          />
        ))}
      </section>

      {accounts.length > 1 && (
        <section>
          <h3 className="px-2 pb-1 text-xs font-medium text-muted-foreground uppercase tracking-wide">{t('account_label')}</h3>
          <FacetButton active={accountId === null} label={t('all_accounts')} onClick={() => onAccountChange(null)} />
          {accounts.map((account) => (
            <FacetButton
              key={account.localAccountId}
              active={accountId === account.localAccountId}
              label={account.label}
              count={String(account.count)}
              onClick={() => onAccountChange(account.localAccountId)}
            />
          ))}
        </section>
      )}

      <section>
        <FacetButton active={!flat} label={t('grouped')} onClick={() => onFlatChange(false)} />
        <FacetButton active={flat} label={t('flat_by_date')} onClick={() => onFlatChange(true)} />
      </section>
    </div>
  );
}
