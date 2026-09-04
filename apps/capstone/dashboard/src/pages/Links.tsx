import { useState } from 'react';
import type { ResourceLink } from '../types';
import { useDashboardData } from '../context/DashboardDataContext';
import StatusBadge from '../components/StatusBadge';
import { cn, formatRelativeTime } from '../lib/utils';

const categories: Array<{ key: ResourceLink['category']; label: string; color: string }> = [
  { key: 'services', label: 'Services', color: 'bg-primary/10 text-primary border-primary/30' },
  { key: 'documentation', label: 'Documentation', color: 'bg-info/10 text-info border-info/30' },
  { key: 'monitoring', label: 'Monitoring Tools', color: 'bg-accent/10 text-accent-foreground border-accent/30' },
  { key: 'repositories', label: 'Repositories', color: 'bg-success/10 text-success border-success/30' },
  { key: 'external', label: 'External Resources', color: 'bg-warning/10 text-warning border-warning/30' },
  { key: 'support', label: 'Support', color: 'bg-muted text-muted-foreground border-muted' },
];

export default function Links() {
  const { links } = useDashboardData();
  const [search, setSearch] = useState('');
  const [categoryFilter, setCategoryFilter] = useState<string>('all');

  const filtered = links.filter(l => {
    const matchesSearch = search === '' || l.name.toLowerCase().includes(search.toLowerCase()) || l.description.toLowerCase().includes(search.toLowerCase()) || l.url.toLowerCase().includes(search.toLowerCase());
    const matchesCategory = categoryFilter === 'all' || l.category === categoryFilter;
    return matchesSearch && matchesCategory;
  });

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Links & Resources</h1>
          <p className="mt-1 text-sm text-muted-foreground">Quick access to services, documentation, repositories, and support.</p>
        </div>
        <div className="flex items-center gap-2">
          <button className="inline-flex items-center gap-2 rounded-lg border bg-background px-3 py-1.5 text-sm text-muted-foreground hover:text-foreground hover:bg-muted transition-colors">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="7 10 12 15 17 10" /><path d="M12 15V3" /></svg>
            Export links
          </button>
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        <div className="relative">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground"><circle cx="11" cy="11" r="8" /><path d="m21 21-4.35-4.35" /></svg>
          <input
            type="search"
            placeholder="Search links…"
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="h-9 w-full min-w-[220px] rounded-md border bg-background pl-9 pr-3 py-2 text-sm placeholder:text-muted-foreground focus:border-primary focus:outline-none"
            aria-label="Search links"
          />
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            onClick={() => setCategoryFilter('all')}
            className={cn('rounded-full px-3 py-1 text-xs font-medium transition-colors', categoryFilter === 'all' ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground hover:text-foreground')}
          >
            All
          </button>
          {categories.map(cat => (
            <button
              key={cat.key}
              onClick={() => setCategoryFilter(cat.key)}
              className={cn('rounded-full px-3 py-1 text-xs font-medium transition-colors', categoryFilter === cat.key ? cat.color : 'bg-muted text-muted-foreground hover:text-foreground')}
            >
              {cat.label}
            </button>
          ))}
        </div>
      </div>

      <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
        {categories.map(cat => {
          const items = filtered.filter(l => l.category === cat.key);
          return (
            <div key={cat.key} className={cn('rounded-2xl border bg-card p-4 shadow-sm', categoryFilter === cat.key ? 'ring-2 ring-primary/40' : '')}>
              <div className="flex items-center gap-2 mb-3">
                <div className={cn('rounded-lg px-2 py-0.5 text-xs font-medium', cat.color)}>
                  {cat.label}
                </div>
                <span className="text-xs text-muted-foreground">{items.length} link{items.length !== 1 ? 's' : ''}</span>
              </div>
              <div className="space-y-3">
                {items.map(link => (
                  <a
                    key={link.id}
                    href={link.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="group flex items-start gap-3 rounded-lg border bg-card p-3 transition-colors hover:bg-muted/40 hover:border-primary/40"
                  >
                    <div className="mt-0.5">
                      {link.category === 'services' ? (
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4 text-primary"><rect x="2" y="3" width="20" height="14" rx="2" /><path d="M8 21h8" /><path d="M12 17v4" /></svg>
                      ) : link.category === 'documentation' ? (
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4 text-info"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path d="m9 13 2 2 4-4" /></svg>
                      ) : link.category === 'monitoring' ? (
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4 text-accent-foreground"><path d="M3 3v18h18" /><path d="m19 9-5 5-4-4-3 3" /></svg>
                      ) : link.category === 'repositories' ? (
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4 text-success"><path d="M9 19c-5 1.5-5-2.5-7-3m14 6v-3.87a3 3 0 0 0-.94-2.61c3.14-.35 6.44-1.54 6.44-7A5.44 5.44 0 0 0 20 4.77 5.07 5.07 0 0 0 19.91 1S18.73.65 16 2.48a13.38 13.38 0 0 0-7 0C6.27.65 5.09 1 5.09 1A5.07 5.07 0 0 0 5 4.77a5.44 5.44 0 0 0-1.5 3.78c0 5.42 3.3 6.61 6.44 7A3 3 0 0 0 9 18.13V22" /></svg>
                      ) : link.category === 'external' ? (
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4 text-warning"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" /><polyline points="15 3 21 3 21 9" /><line x1="10" y1="14" x2="21" y2="3" /></svg>
                      ) : (
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4 text-muted-foreground"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" /></svg>
                      )}
                    </div>
                    <div className="flex-1 min-w-0">
                      <h3 className="text-sm font-medium group-hover:text-primary transition-colors">{link.name}</h3>
                      <p className="mt-1 text-xs text-muted-foreground line-clamp-2">{link.description}</p>
                      <div className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
                        <span className="truncate max-w-[180px] font-mono">{link.url}</span>
                        <span className="text-muted-foreground/50">·</span>
                        <span>{formatRelativeTime(link.lastVerified)}</span>
                      </div>
                    </div>
                    <div className="shrink-0">
                      <StatusBadge status={link.status} size="sm" />
                    </div>
                  </a>
                ))}
                {items.length === 0 && (
                  <div className="py-4 text-center text-sm text-muted-foreground">No links in this category.</div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
