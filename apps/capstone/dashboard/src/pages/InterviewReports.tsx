import { useCallback, useEffect, useMemo, useState } from 'react';
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
}: {
  report: InterviewReport | null;
  onClose: () => void;
}) {
  const [showTranscript, setShowTranscript] = useState(false);
  useEffect(() => setShowTranscript(false), [report]);
  if (!report) return null;
  return (
    <Modal open={!!report} onClose={onClose} title={`${report.student || 'Candidate'} — ${report.trackLabel}`} size="lg">
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

  // The open report lives in the URL (?report=<id>) so the overview widget
  // can deep-link into a single report, the URL is shareable, and the
  // browser's Back button closes the modal.
  const [searchParams, setSearchParams] = useSearchParams();
  const reportParam = searchParams.get('report');
  const selected = useMemo(
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
      const res = await api.interviewReports();
      setConfigured(res.configured);
      setConfigError(res.error ?? null);
      setReports(res.reports);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load interview reports');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return reports.filter(r => {
      if (track !== 'all' && r.track !== track) return false;
      if (!needle) return true;
      const haystack = `${r.student} ${r.phone} ${r.runId} ${r.trackLabel}`.toLowerCase();
      return haystack.includes(needle);
    });
  }, [reports, track, search]);

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
    const header = 'student,track,phone,score,verdict,runId';
    const rows = filtered.map(r =>
      [r.student, r.track, r.phone, r.score ?? '', r.verdict, r.runId]
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
          </p>
        </div>
        <div className="flex items-center gap-2">
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
        <StatChip label="Reports" value={String(stats.total)} />
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
            placeholder="Search by student, phone, run…"
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="h-9 w-full min-w-[220px] rounded-md border bg-background py-2 pl-9 pr-3 text-sm placeholder:text-muted-foreground focus:border-primary focus:outline-none"
            aria-label="Search interview reports"
          />
        </div>
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

      {loading ? (
        <div className="flex min-h-[30vh] items-center justify-center">
          <Spinner className="h-6 w-6 text-primary" />
        </div>
      ) : (
        <div className="overflow-hidden rounded-2xl border bg-card shadow-sm">
          <table className="w-full border-collapse">
            <thead>
              <tr className="border-b bg-muted/30">
                <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-muted-foreground">Student</th>
                <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-muted-foreground">Track</th>
                <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-muted-foreground">Phone</th>
                <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-muted-foreground">Score</th>
                <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-muted-foreground">Verdict</th>
                <th className="w-[110px] px-4 py-3 text-right text-xs font-semibold uppercase tracking-wider text-muted-foreground">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {filtered.map(r => (
                <tr
                  key={r.id}
                  className="cursor-pointer transition-colors hover:bg-muted/40"
                  onClick={() => openReport(r)}
                >
                  <td className="px-4 py-3 text-sm font-medium">{r.student || '—'}</td>
                  <td className="px-4 py-3 text-sm text-muted-foreground">{r.trackLabel}</td>
                  <td className="px-4 py-3 font-mono text-sm text-muted-foreground">{r.phone || '—'}</td>
                  <td className="px-4 py-3"><ScoreBadge score={r.score} /></td>
                  <td className="px-4 py-3"><VerdictChip verdict={r.verdict} /></td>
                  <td className="px-4 py-3 text-right">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 text-xs text-muted-foreground hover:text-foreground"
                      onClick={e => { e.stopPropagation(); openReport(r); }}
                    >
                      View
                    </Button>
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
              <p className="mt-2 text-sm font-medium">No interview reports yet.</p>
              <p className="text-xs text-muted-foreground">
                Reports appear here after the first graded call hang-up.
              </p>
            </div>
          )}
        </div>
      )}

      <ReportModal report={selected} onClose={closeReport} />
    </div>
  );
}
