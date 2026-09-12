import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api, type DimensionScore, type InterviewReport } from '../lib/api';
import Button from '../components/Button';
import Modal from '../components/Modal';
import Spinner from '../components/Spinner';
import { cn, scoreToneClass, verdictChipClass } from '../lib/utils';

const TRACKS = [
  { value: 'all', label: 'All tracks' },
  { value: 'it', label: 'IT Help Desk' },
  { value: 'devops', label: 'DevOps' },
  { value: 'sql', label: 'SQL' },
] as const;

function VerdictChip({ verdict }: { verdict: InterviewReport['verdict'] }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium capitalize',
        verdictChipClass(verdict),
      )}
    >
      <span className="h-1.5 w-1.5 rounded-full bg-current" />
      {verdict}
    </span>
  );
}

function ScoreBadge({ score }: { score: number | null }) {
  if (score === null || Number.isNaN(score)) {
    return <span className="text-sm text-muted-foreground">—</span>;
  }
  return (
    <span className={cn('text-sm font-semibold tabular-nums', scoreToneClass(score))}>
      {Math.round(score)}
      <span className="text-xs font-normal text-muted-foreground">/100</span>
    </span>
  );
}

function DimensionRow({ dim }: { dim: DimensionScore }) {
  return (
    <li className="flex items-start justify-between gap-3 py-1.5">
      <div className="min-w-0">
        <div className="text-sm font-medium">
          {dim.name.replace(/_/g, ' ')}
        </div>
        {dim.evidence && (
          <div className="mt-0.5 truncate text-xs text-muted-foreground" title={dim.evidence}>
            “{dim.evidence}”
          </div>
        )}
      </div>
      <span className="shrink-0 rounded-md bg-muted px-2 py-0.5 text-xs font-semibold tabular-nums">
        {dim.score ?? '—'}
      </span>
    </li>
  );
}

function ReportModal({
  report,
  onClose,
  onDelete,
  onRestore,
  busy,
}: {
  report: InterviewReport | null;
  onClose: () => void;
  onDelete: (report: InterviewReport) => void;
  onRestore: (report: InterviewReport) => void;
  busy: boolean;
}) {
  const [showTranscript, setShowTranscript] = useState(false);
  useEffect(() => setShowTranscript(false), [report]);
  if (!report) return null;
  return (
    <Modal open={!!report} onClose={onClose} title={`${report.prospect || 'Prospect'} — ${report.trackLabel}`} size="lg">
      <div className="space-y-5">
        <div className="flex flex-wrap items-center gap-3">
          <VerdictChip verdict={report.verdict} />
          <ScoreBadge score={report.score} />
          <span className="text-xs text-muted-foreground">
            {report.phone && <>· {report.phone} </>}
            {report.runId && <>· run {report.runId}</>}
          </span>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <h3 className="mb-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Strengths</h3>
            {report.strengths.length ? (
              <ul className="list-inside list-disc space-y-1 text-sm">
                {report.strengths.map((s, i) => <li key={i}>{s}</li>)}
              </ul>
            ) : (
              <p className="text-sm text-muted-foreground">None recorded.</p>
            )}
          </div>
          <div>
            <h3 className="mb-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Improvements</h3>
            {report.improvements.length ? (
              <ul className="list-inside list-disc space-y-1 text-sm">
                {report.improvements.map((s, i) => <li key={i}>{s}</li>)}
              </ul>
            ) : (
              <p className="text-sm text-muted-foreground">None recorded.</p>
            )}
          </div>
        </div>

        <div>
          <h3 className="mb-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Dimension scores
          </h3>
          {report.dimensions.length ? (
            <ul className="divide-y rounded-lg border px-3">
              {report.dimensions.map((dim, i) => <DimensionRow key={i} dim={dim} />)}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">
              {report.parseError
                ? `The grader output could not be parsed (${report.parseError}).`
                : 'No dimension data in this report.'}
            </p>
          )}
        </div>

        {report.transcript && (
          <div>
            <button
              type="button"
              onClick={() => setShowTranscript(v => !v)}
              className="flex items-center gap-1.5 text-sm font-medium text-primary hover:underline"
            >
              <svg
                viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
                strokeLinecap="round" strokeLinejoin="round"
                className={cn('h-4 w-4 transition-transform', showTranscript && 'rotate-90')}
              >
                <path d="m9 18 6-6-6-6" />
              </svg>
              {showTranscript ? 'Hide' : 'Show'} call transcript
            </button>
            {showTranscript && (
              <pre className="mt-2 max-h-72 overflow-y-auto whitespace-pre-wrap rounded-lg border bg-muted/30 p-3 text-xs leading-relaxed scrollbar-thin">
                {report.transcript}
              </pre>
            )}
          </div>
        )}

        <div className="flex flex-wrap items-center justify-between gap-3 border-t pt-4">
          <p className="text-xs text-muted-foreground">
            {report.deleted
              ? 'Deleted — restore it, or delete it permanently (no undo).'
              : 'Deleting hides this report; undo it right after, or restore it later from “Show deleted”.'}
          </p>
          <div className="flex shrink-0 items-center gap-2">
            {report.deleted && (
              <Button variant="outline" size="sm" disabled={busy} onClick={() => onRestore(report)}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4">
                  <path d="M1 4v6h6" /><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
                </svg>
                Restore
              </Button>
            )}
            <Button
              variant="outline"
              size="sm"
              className="text-danger hover:text-danger"
              disabled={busy}
              onClick={() => onDelete(report)}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4">
                <path d="M3 6h18" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
                <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
              </svg>
              {busy ? 'Working…' : report.deleted ? 'Delete permanently' : 'Delete report'}
            </Button>
          </div>
        </div>
      </div>
    </Modal>
  );
}

function StatChip({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="rounded-xl border bg-card px-4 py-3 shadow-sm">
      <div className={cn('text-xl font-semibold tabular-nums', tone)}>{value}</div>
      <div className="text-xs text-muted-foreground">{label}</div>
    </div>
  );
}

export default function InterviewReports() {
  const [reports, setReports] = useState<InterviewReport[]>([]);
  const [configured, setConfigured] = useState(true);
  const [configError, setConfigError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [track, setTrack] = useState<string>('all');
  const [search, setSearch] = useState('');

  // Deleting is the one write this page does. It is confirmed first and goes
  // through the session-gated report endpoints; deleting is a *soft* delete
  // (Grist's `Deleted` flag), so it can be undone here or restored later from
  // the "show deleted" view.
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState(false);
  const [showDeleted, setShowDeleted] = useState(false);
  const [undo, setUndo] = useState<{ ids: number[]; count: number } | null>(null);

  // The open report lives in the URL (?report=<id>) so the overview widget
  // can deep-link into a single report, the URL is shareable, and the
  // browser's Back button closes the modal.
  const [searchParams, setSearchParams] = useSearchParams();
  const reportParam = searchParams.get('report');
  const openedReport = useMemo(
    () => (reportParam ? reports.find(r => String(r.id) === reportParam) ?? null : null),
    [reports, reportParam],
  );

  const openReport = useCallback(
    (report: InterviewReport) => {
      const next = new URLSearchParams(searchParams);
      next.set('report', String(report.id));
      setSearchParams(next);
    },
    [searchParams, setSearchParams],
  );

  const closeReport = useCallback(() => {
    const next = new URLSearchParams(searchParams);
    next.delete('report');
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams]);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      // Deleted rows come back too: the page shows them behind its "show
      // deleted" toggle and needs their data to offer Restore.
      const res = await api.interviewReports(true);
      setConfigured(res.configured);
      setConfigError(res.error ?? null);
      setReports(res.reports);
      // Drop ids that no longer exist (deleted here or in Grist directly) so
      // a stale selection can't be sent to the delete endpoint.
      const live = new Set(res.reports.map(r => r.id));
      setSelected(prev => new Set([...prev].filter(id => live.has(id))));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load interview reports');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const runWrite = useCallback(
    async (action: 'delete' | 'restore' | 'purge', ids: number[], label: string) => {
      setBusy(true);
      setError(null);
      try {
        if (action === 'delete') {
          if (ids.length === 1) await api.deleteInterviewReport(ids[0]);
          else await api.deleteInterviewReports(ids);
          setUndo({ ids, count: ids.length });
        } else if (action === 'restore') {
          await api.restoreInterviewReports(ids);
          setUndo(null);
        } else {
          await api.purgeInterviewReports(ids);
          setUndo(null);
        }
        // The open report may be one of the rows just written — close the
        // modal instead of leaving it pointing at an updated record.
        if (reportParam && ids.includes(Number(reportParam))) closeReport();
        setSelected(new Set());
        await refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : `Failed to ${action} ${label}`);
      } finally {
        setBusy(false);
      }
    },
    [closeReport, reportParam, refresh],
  );

  const describe = (report: InterviewReport) =>
    `${report.prospect || 'this report'} (${report.trackLabel}`
    + `${report.score !== null ? `, score ${Math.round(report.score)}` : ''})`;

  const deleteReport = useCallback(
    (report: InterviewReport) => {
      // A row that is already soft-deleted can only be purged (no undo).
      if (report.deleted) {
        if (!window.confirm(
          `Permanently delete ${describe(report)}?\n\n`
          + 'The row is removed from Grist for good — this cannot be undone.')) return;
        void runWrite('purge', [report.id], 'report');
        return;
      }
      if (!window.confirm(
        `Delete ${describe(report)}?\n\n`
        + 'It is hidden from the list and kept restorable — undo it right after, or restore it later from “Show deleted”.')) return;
      void runWrite('delete', [report.id], 'report');
    },
    [runWrite],
  );

  const restoreReport = useCallback(
    (report: InterviewReport) => {
      void runWrite('restore', [report.id], 'report');
    },
    [runWrite],
  );

  const live = useMemo(() => reports.filter(r => !r.deleted), [reports]);
  const deleted = useMemo(() => reports.filter(r => r.deleted), [reports]);

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return (showDeleted ? deleted : live).filter(r => {
      if (track !== 'all' && r.track !== track) return false;
      if (!needle) return true;
      const haystack = `${r.prospect} ${r.phone} ${r.runId} ${r.trackLabel}`.toLowerCase();
      return haystack.includes(needle);
    });
  }, [showDeleted, deleted, live, track, search]);

  // Undo window after a delete: the rows are only flagged, so a mis-click is
  // recoverable without leaving the page. Later deletes still live in the
  // "show deleted" view, so the timer only hides the banner.
  useEffect(() => {
    if (!undo) return;
    const timer = window.setTimeout(() => setUndo(null), 15000);
    return () => window.clearTimeout(timer);
  }, [undo]);

  const allShownSelected = filtered.length > 0 && filtered.every(r => selected.has(r.id));
  const someShownSelected = !allShownSelected && filtered.some(r => selected.has(r.id));
  const selectAllRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (selectAllRef.current) selectAllRef.current.indeterminate = someShownSelected;
  }, [someShownSelected]);

  const toggleSelected = (id: number) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleAllShown = () => {
    setSelected(prev => {
      const next = new Set(prev);
      if (allShownSelected) filtered.forEach(r => next.delete(r.id));
      else filtered.forEach(r => next.add(r.id));
      return next;
    });
  };

  // In the deleted view the same buttons mean "restore" / "purge": a row that
  // is already soft-deleted can't be deleted again, only brought back or
  // removed for good.
  const deleteSelected = () => {
    const ids = [...selected];
    if (!ids.length) return;
    if (showDeleted) {
      void runWrite('restore', ids, 'selected reports');
      return;
    }
    if (!window.confirm(
      `Delete ${ids.length} selected interview report${ids.length === 1 ? '' : 's'}?\n\n`
      + 'They are hidden from the list and kept restorable — undo, or restore them later from “Show deleted”.')) return;
    void runWrite('delete', ids, 'selected reports');
  };

  const purgeSelected = () => {
    const ids = [...selected];
    if (!ids.length) return;
    if (!window.confirm(
      `Permanently delete ${ids.length} selected report${ids.length === 1 ? '' : 's'}?\n\n`
      + 'The rows are removed from Grist for good — this cannot be undone.')) return;
    void runWrite('purge', ids, 'selected reports');
  };

  const allShown = () => {
    const ids = filtered.map(r => r.id);
    if (!ids.length) return;
    const scope = [
      track !== 'all' ? `track “${TRACKS.find(t => t.value === track)?.label ?? track}”` : '',
      search.trim() ? `search “${search.trim()}”` : '',
    ].filter(Boolean).join(' + ');
    const where = `currently shown${scope ? ` (${scope})` : ''}`;
    if (showDeleted) {
      if (!window.confirm(
        `Permanently delete all ${ids.length} report${ids.length === 1 ? '' : 's'} ${where}?\n\n`
        + 'The rows are removed from Grist for good — this cannot be undone.')) return;
      void runWrite('purge', ids, 'shown reports');
      return;
    }
    if (!window.confirm(
      `Delete all ${ids.length} report${ids.length === 1 ? '' : 's'} ${where}?\n\n`
      + 'They are hidden from the list and kept restorable — restore them any time from “Show deleted”.')) return;
    void runWrite('delete', ids, 'shown reports');
  };

  const stats = useMemo(() => {
    const scored = filtered.filter(r => r.score !== null);
    const avg = scored.length
      ? Math.round(scored.reduce((sum, r) => sum + (r.score ?? 0), 0) / scored.length)
      : null;
    return {
      total: filtered.length,
      pass: filtered.filter(r => r.verdict === 'pass').length,
      review: filtered.filter(r => r.verdict === 'review').length,
      fail: filtered.filter(r => r.verdict === 'fail').length,
      avg,
    };
  }, [filtered]);

  const exportCsv = () => {
    const header = 'prospect,track,phone,score,verdict,runId';
    const rows = filtered.map(r =>
      [r.prospect, r.track, r.phone, r.score ?? '', r.verdict, r.runId]
        .map(v => `"${String(v).replace(/"/g, '""')}"`)
        .join(','),
    );
    const blob = new Blob([[header, ...rows].join('\n')], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'interview-reports.csv';
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Interview Reports</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Graded mock-interview reports written by the n8n Interview Grader on call hang-up.
            The prospect is whoever called in — their name is picked up from the conversation and
            the phone column is the number they called from. Deleting keeps a report restorable
            until you remove it permanently from “Show deleted”.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            className="text-danger hover:text-danger"
            onClick={allShown}
            disabled={loading || busy || !filtered.length}
            title={showDeleted
              ? 'Remove every deleted report in the table from Grist for good'
              : track === 'all' && !search.trim()
                ? 'Delete every report in the table (restorable)'
                : 'Delete every report matching the current track/search filter (restorable)'}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4">
              <path d="M3 6h18" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
              <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
            </svg>
            {showDeleted ? 'Delete permanently' : 'Delete all shown'}
          </Button>
          <Button variant="outline" size="sm" onClick={() => { void refresh(); }} disabled={loading}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4">
              <path d="M1 4v6h6" /><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
            </svg>
            Refresh
          </Button>
          <Button variant="outline" size="sm" onClick={exportCsv} disabled={!filtered.length}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="7 10 12 15 17 10" /><path d="M12 15V3" />
            </svg>
            Export CSV
          </Button>
        </div>
      </div>

      {!configured && (
        <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-700 dark:text-amber-300">
          <span className="font-semibold">Grist not configured.</span>{' '}
          {configError ?? 'Set GRIST_DOC_ID and GRIST_API_KEY in .env, then restart dashboard-api.'}
        </div>
      )}
      {error && (
        <div className="rounded-xl border border-danger/30 bg-danger/10 px-4 py-3 text-sm text-danger">
          {error}
        </div>
      )}

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatChip label={showDeleted ? 'Deleted shown' : 'Reports'} value={String(stats.total)} />
        <StatChip label="Passed" value={String(stats.pass)} tone="text-success" />
        <StatChip label="Review" value={String(stats.review)} tone="text-warning" />
        <StatChip
          label="Average score"
          value={stats.avg !== null ? `${stats.avg}` : '—'}
          tone={stats.avg !== null ? scoreToneClass(stats.avg) : undefined}
        />
      </div>

      <div className="flex flex-wrap gap-3">
        <div className="relative">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground">
            <circle cx="11" cy="11" r="8" /><path d="m21 21-4.35-4.35" />
          </svg>
          <input
            type="search"
            placeholder="Search by prospect, phone, run…"
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="h-9 w-full min-w-[220px] rounded-md border bg-background py-2 pl-9 pr-3 text-sm placeholder:text-muted-foreground focus:border-primary focus:outline-none"
            aria-label="Search interview reports"
          />
        </div>
        <button
          type="button"
          onClick={() => { setShowDeleted(v => !v); setSelected(new Set()); }}
          aria-pressed={showDeleted}
          className={cn(
            'h-9 rounded-md border px-3 text-xs font-medium transition-colors',
            showDeleted
              ? 'border-warning/40 bg-warning/10 text-warning'
              : 'bg-background text-muted-foreground hover:text-foreground',
          )}
        >
          {showDeleted ? 'Showing deleted' : 'Show deleted'}
          {deleted.length > 0 && <span className="ml-1.5 tabular-nums">({deleted.length})</span>}
        </button>
        <div className="flex rounded-md border bg-background p-1" role="group" aria-label="Track filter">
          {TRACKS.map(t => (
            <button
              key={t.value}
              onClick={() => setTrack(t.value)}
              className={cn(
                'rounded-md px-3 py-1.5 text-xs font-medium transition-colors',
                track === t.value ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {undo && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-warning/30 bg-warning/10 px-4 py-2.5">
          <span className="text-sm">
            {undo.count} report{undo.count === 1 ? '' : 's'} deleted — kept restorable.
          </span>
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={() => setUndo(null)} disabled={busy}>
              Dismiss
            </Button>
            <Button variant="outline" size="sm" onClick={() => void runWrite('restore', undo.ids, 'report')} disabled={busy}>
              {busy ? 'Working…' : `Undo (${undo.count})`}
            </Button>
          </div>
        </div>
      )}

      {selected.size > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border bg-muted/40 px-4 py-2.5">
          <span className="text-sm font-medium">{selected.size} report{selected.size === 1 ? '' : 's'} selected</span>
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={() => setSelected(new Set())} disabled={busy}>
              Clear selection
            </Button>
            {showDeleted ? (
              <>
                <Button variant="outline" size="sm" onClick={deleteSelected} disabled={busy}>
                  {busy ? 'Working…' : `Restore selected (${selected.size})`}
                </Button>
                <Button variant="destructive" size="sm" onClick={purgeSelected} disabled={busy}>
                  Delete permanently
                </Button>
              </>
            ) : (
              <Button variant="destructive" size="sm" onClick={deleteSelected} disabled={busy}>
                {busy ? 'Deleting…' : `Delete selected (${selected.size})`}
              </Button>
            )}
          </div>
        </div>
      )}

      {loading ? (
        <div className="flex min-h-[30vh] items-center justify-center">
          <Spinner className="h-6 w-6 text-primary" />
        </div>
      ) : (
        <div className="overflow-hidden rounded-2xl border bg-card shadow-sm">
          <table className="w-full border-collapse">
            <thead>
              <tr className="border-b bg-muted/30">
                <th className="w-10 px-4 py-3">
                  <input
                    ref={selectAllRef}
                    type="checkbox"
                    className="h-4 w-4 cursor-pointer accent-primary align-middle"
                    checked={allShownSelected}
                    onChange={toggleAllShown}
                    disabled={!filtered.length || busy}
                    aria-label="Select all shown reports"
                  />
                </th>
                <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-muted-foreground">Prospect</th>
                <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-muted-foreground">Track</th>
                <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-muted-foreground">Phone</th>
                <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-muted-foreground">Score</th>
                <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-muted-foreground">Verdict</th>
                <th className="w-[230px] px-4 py-3 text-right text-xs font-semibold uppercase tracking-wider text-muted-foreground">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {filtered.map(r => (
                <tr
                  key={r.id}
                  className="cursor-pointer transition-colors hover:bg-muted/40"
                  onClick={() => openReport(r)}
                >
                  <td className="px-4 py-3" onClick={e => e.stopPropagation()}>
                    <input
                      type="checkbox"
                      className="h-4 w-4 cursor-pointer accent-primary align-middle"
                      checked={selected.has(r.id)}
                      onChange={() => toggleSelected(r.id)}
                      disabled={busy}
                      aria-label={`Select ${r.prospect || 'report'}`}
                    />
                  </td>
                  <td className="px-4 py-3 text-sm font-medium">{r.prospect || '—'}</td>
                  <td className="px-4 py-3 text-sm text-muted-foreground">{r.trackLabel}</td>
                  <td className="px-4 py-3 font-mono text-sm text-muted-foreground">{r.phone || '—'}</td>
                  <td className="px-4 py-3"><ScoreBadge score={r.score} /></td>
                  <td className="px-4 py-3"><VerdictChip verdict={r.verdict} /></td>
                  <td className="px-4 py-3 text-right">
                    <div className="flex items-center justify-end gap-1">
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 text-xs text-muted-foreground hover:text-foreground"
                        onClick={e => { e.stopPropagation(); openReport(r); }}
                      >
                        View
                      </Button>
                      {r.deleted && (
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-7 text-xs"
                          onClick={e => { e.stopPropagation(); restoreReport(r); }}
                          disabled={busy}
                        >
                          Restore
                        </Button>
                      )}
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 text-xs text-muted-foreground hover:text-danger"
                        onClick={e => { e.stopPropagation(); deleteReport(r); }}
                        disabled={busy}
                      >
                        {r.deleted ? 'Delete permanently' : 'Delete'}
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {filtered.length === 0 && (
            <div className="flex flex-col items-center justify-center border-t py-12 text-center">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="mx-auto h-8 w-8 text-muted-foreground">
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                <path d="M14 2v6h6" /><path d="m9 13 2 2 4-4" />
              </svg>
              {showDeleted ? (
                <>
                  <p className="mt-2 text-sm font-medium">No deleted reports.</p>
                  <p className="text-xs text-muted-foreground">
                    Reports you delete from this page land here, restorable, until you remove them for good.
                  </p>
                </>
              ) : (
                <>
                  <p className="mt-2 text-sm font-medium">No interview reports yet.</p>
                  <p className="text-xs text-muted-foreground">
                    Reports appear here after the first graded call hang-up.
                  </p>
                </>
              )}
            </div>
          )}
        </div>
      )}

      <ReportModal
        report={openedReport}
        onClose={closeReport}
        onDelete={deleteReport}
        onRestore={restoreReport}
        busy={busy}
      />
    </div>
  );
}
