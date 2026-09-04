import { useState, useMemo } from 'react';
import { useDashboardData } from '../context/DashboardDataContext';
import Button from '../components/Button';
import { cn, formatRelativeTime } from '../lib/utils';
import { exportJSON } from '../lib/export';

function levelBadge(action: string) {
  if (action.includes('restart') || action.includes('rotate') || action.includes('revoke')) {
    return <span className="inline-flex items-center gap-1 rounded-full bg-danger/20 px-2 py-0.5 text-xs font-medium text-danger"><span className="h-1.5 w-1.5 rounded-full bg-danger" />Destructive</span>;
  }
  if (action.includes('create') || action.includes('add') || action.includes('scale') || action.includes('backup')) {
    return <span className="inline-flex items-center gap-1 rounded-full bg-success/20 px-2 py-0.5 text-xs font-medium text-success"><span className="h-1.5 w-1.5 rounded-full bg-success" />Create/Modify</span>;
  }
  if (action.includes('acknowledge') || action.includes('resolve')) {
    return <span className="inline-flex items-center gap-1 rounded-full bg-warning/20 px-2 py-0.5 text-xs font-medium text-warning"><span className="h-1.5 w-1.5 rounded-full bg-warning" />Ops</span>;
  }
  if (action.includes('view') || action.includes('export') || action.includes('read')) {
    return <span className="inline-flex items-center gap-1 rounded-full bg-info/20 px-2 py-0.5 text-xs font-medium text-info"><span className="h-1.5 w-1.5 rounded-full bg-info" />Read</span>;
  }
  return <span className="text-xs text-muted-foreground">{action}</span>;
}

export default function Logs() {
  const { auditLog } = useDashboardData();
  const [search, setSearch] = useState('');
  const [levelFilter, setLevelFilter] = useState<string>('all');
  const [actorFilter, setActorFilter] = useState<string>('all');
  const [copyFeedback, setCopyFeedback] = useState<string | null>(null);

  const levelOptions = ['all', 'Read', 'Ops', 'Create/Modify', 'Destructive'];

  const filtered = useMemo(() => {
    return auditLog.filter(entry => {
      const matchesSearch = search === '' || entry.action.toLowerCase().includes(search.toLowerCase()) || entry.resource.toLowerCase().includes(search.toLowerCase()) || entry.details.toLowerCase().includes(search.toLowerCase()) || entry.actor.toLowerCase().includes(search.toLowerCase());
      const level = levelBadge(entry.action).props.className ?? '';
      const matchesLevel = levelFilter === 'all' || level.includes(levelFilter.toLowerCase());
      const matchesActor = actorFilter === 'all' || entry.actor === actorFilter;
      return matchesSearch && matchesLevel && matchesActor;
    });
  }, [search, levelFilter, actorFilter]);

  const uniqueActors = Array.from(new Set(auditLog.map(e => e.actor)));

  const copyEntry = (id: string) => {
    const entry = auditLog.find(e => e.id === id);
    if (!entry) return;
    const text = JSON.stringify(entry, null, 2);
    navigator.clipboard.writeText(text).then(() => {
      setCopyFeedback(id);
      setTimeout(() => setCopyFeedback(null), 2000);
    }).catch(() => {});
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Logs</h1>
          <p className="mt-1 text-sm text-muted-foreground">Audit log entries for configuration changes, access, and operational actions.</p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => {
            const csv = ['timestamp,actor,action,resource,details,ip', ...auditLog.map(e => `${e.timestamp},${e.actor},${e.action},${e.resource},${e.details},${e.ip}`)].join('\n');
            const blob = new Blob([csv], { type: 'text/csv' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = 'capstone-audit-log.csv';
            a.click();
            URL.revokeObjectURL(url);
          }}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="7 10 12 15 17 10" /><path d="M12 15V3" /></svg>
            Export CSV
          </Button>
          <Button variant="outline" size="sm" onClick={() => exportJSON(filtered, { filename: `capstone-audit-log-${new Date().toISOString().slice(0, 10)}.json` })}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4"><path d="M3 3v18h18" /><path d="m19 9-5 5-4-4-3 3" /></svg>
            Download JSON
          </Button>
        </div>
      </div>

      <div className="flex flex-wrap gap-3">
        <div className="relative">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground"><circle cx="11" cy="11" r="8" /><path d="m21 21-4.35-4.35" /></svg>
          <input
            type="search"
            placeholder="Search logs by action, resource, actor…"
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="h-9 w-full min-w-[220px] rounded-md border bg-background pl-9 pr-3 py-2 text-sm placeholder:text-muted-foreground focus:border-primary focus:outline-none"
            aria-label="Search logs"
          />
        </div>
        <div className="flex rounded-md border bg-background p-1" role="group" aria-label="Level filter">
          {levelOptions.map(l => (
            <button
              key={l}
              onClick={() => setLevelFilter(l)}
              className={cn('rounded-md px-3 py-1.5 text-xs font-medium transition-colors', levelFilter === l ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground')}
            >
              {l}
            </button>
          ))}
        </div>
        <div className="flex rounded-md border bg-background p-1" role="group" aria-label="Actor filter">
          {uniqueActors.map(a => (
            <button
              key={a}
              onClick={() => setActorFilter(a === 'system' ? 'all' : a)}
              className={cn('rounded-md px-3 py-1.5 text-xs font-medium transition-colors', actorFilter === a ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground')}
            >
              {a}
            </button>
          ))}
        </div>
      </div>

      <div className="border rounded-2xl bg-card shadow-sm overflow-hidden">
        <table className="w-full border-collapse">
          <thead>
            <tr className="border-b bg-muted/30">
              <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-muted-foreground">Time</th>
              <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-muted-foreground">Actor</th>
              <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-muted-foreground">Action</th>
              <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-muted-foreground">Resource</th>
              <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-muted-foreground">Details</th>
              <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-muted-foreground">IP</th>
              <th className="px-4 py-3 w-[120px]">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {filtered.map(entry => (
              <tr key={entry.id} className="hover:bg-muted/40 transition-colors">
                <td className="px-4 py-3 text-sm text-muted-foreground">{formatRelativeTime(entry.timestamp)}</td>
                <td className="px-4 py-3">
                  <div className="flex items-center gap-2">
                    <div className="flex h-6 w-6 items-center justify-center rounded-full bg-primary/10 text-primary text-xs font-semibold">
                      {entry.actor.charAt(0)}
                    </div>
                    <span className="text-sm">{entry.actor}</span>
                  </div>
                </td>
                <td className="px-4 py-3">{levelBadge(entry.action)}</td>
                <td className="px-4 py-3 text-sm font-mono text-muted-foreground">{entry.resource}</td>
                <td className="px-4 py-3 text-sm text-muted-foreground max-w-[240px] truncate">{entry.details}</td>
                <td className="px-4 py-3 text-sm font-mono text-muted-foreground">{entry.ip}</td>
                <td className="px-4 py-3">
                  <div className="flex gap-1">
                    <Button variant="ghost" size="sm" className="h-7 text-xs text-muted-foreground hover:text-foreground" onClick={() => copyEntry(entry.id)}>
                      {copyFeedback === entry.id ? 'Copied' : (
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-3.5 w-3.5"><rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></svg>
                      )}
                    </Button>
                    <Button variant="ghost" size="sm" className="h-7 text-xs text-muted-foreground hover:text-foreground">
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-3.5 w-3.5"><path d="M1 4v6h6" /><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" /></svg>
                    </Button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {filtered.length === 0 && (
          <div className="flex flex-col items-center justify-center py-12 border-t text-center">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="mx-auto h-8 w-8 text-muted-foreground"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path d="m9 13 2 2 4-4" /></svg>
            <p className="mt-2 text-sm font-medium">No log entries match your filters.</p>
            <p className="text-xs text-muted-foreground">Try clearing the search or filters.</p>
          </div>
        )}
      </div>
    </div>
  );
}
