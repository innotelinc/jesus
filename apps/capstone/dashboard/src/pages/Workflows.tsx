import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  api,
  type Agent,
  type AgentWorkflow,
  type GradableWorkflow,
  type Workflow,
} from '../lib/api';
import Button from '../components/Button';
import Modal from '../components/Modal';
import Spinner from '../components/Spinner';
import WorkflowForm from '../components/WorkflowForm';
import { cn } from '../lib/utils';

export default function Workflows() {
  const [mode, setMode] = useState<'standalone' | 'addon'>('standalone');
  const [configured, setConfigured] = useState(true);
  const [workflows, setWorkflows] = useState<AgentWorkflow[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [createOpen, setCreateOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<Workflow | null>(null);
  const [busy, setBusy] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  // Grading selection + plan per workflow (see the Graded column).
  const [gradings, setGradings] = useState<GradableWorkflow[] | null>(null);
  const [gradingError, setGradingError] = useState<string | null>(null);
  const [planTarget, setPlanTarget] = useState<GradableWorkflow | null>(null);

  // Deep link from the Agents page: /workflows?workflow=<id> opens it to edit.
  const [searchParams] = useSearchParams();
  const openedWorkflowParam = useRef<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.agents();
      setMode(res.mode);
      setConfigured(res.configured);
      setAgents(res.agents);
      if (!res.configured && res.error) setError(res.error);
      if (res.configured) {
        setWorkflows(await api.workflows());
        // A grading lookup failure must not blank the workflows table, so it
        // gets its own banner rather than the page-level error.
        try {
          setGradings((await api.gradingWorkflows()).workflows);
          setGradingError(null);
        } catch (e) {
          setGradings(null);
          setGradingError(e instanceof Error ? e.message : 'Failed to load grading state');
        }
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load workflows');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const flash = (msg: string) => {
    setNotice(msg);
    window.setTimeout(() => setNotice(null), 5000);
  };

  const handleEdit = async (id: number) => {
    setBusy(true);
    setError(null);
    try {
      setEditTarget(await api.workflow(id));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load workflow');
    } finally {
      setBusy(false);
    }
  };

  // Archived rows are hidden unless the toggle is on (the deep-link below still
  // opens one — the Agents page can link to a bound-but-archived workflow).
  const visibleWorkflows = showArchived
    ? workflows
    : workflows.filter(w => w.status !== 'archived');

  useEffect(() => {
    const raw = searchParams.get('workflow');
    if (!raw || openedWorkflowParam.current === raw || workflows.length === 0) return;
    if (!workflows.some(w => String(w.id) === raw)) return;
    openedWorkflowParam.current = raw;
    void handleEdit(Number(raw));
    // handleEdit only runs once per ?workflow= value (guarded by the ref).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams, workflows]);

  const handleStatus = async (workflow: AgentWorkflow, next: 'active' | 'archived') => {
    const bound = agents.filter(a => a.workflowId === workflow.id);
    if (next === 'archived' && bound.length > 0) {
      const names = bound.map(a => `${a.label} (${a.extension || a.address})`).join(', ');
      if (!window.confirm(
        `Archive workflow ${workflow.name}? It is still bound to ${bound.length} agent${bound.length === 1 ? '' : 's'}: ${names}. `
        + 'Their calls will have no inbound workflow until you bind another.',
      )) return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.setWorkflowStatus(workflow.id, { status: next, force: next === 'archived' });
      flash(`Workflow ${workflow.name} ${next === 'archived' ? 'archived' : 'restored'} in dograh.`);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Status change failed');
    } finally {
      setBusy(false);
    }
  };

  const gradingFor = (id: number) => gradings?.find(g => g.id === id) ?? null;
  const planGrading = planTarget?.grading ?? null;
  const planDimensions = planGrading?.meta?.dimensions ?? [];

  /** Select/deselect a workflow for grading (enabling writes a plan if needed). */
  const toggleGrading = async (id: number, name: string, next: boolean) => {
    setBusy(true);
    setError(null);
    try {
      const res = next
        ? await api.enableGrading(id)
        : await api.disableGrading(id);
      flash(next
        ? `Grading enabled for ${name} in dograh — `
          + (res.addedWebhook ? 'a post-call webhook was added, and ' : '')
          + (res.grading.mode === 'custom'
            ? 'a grading plan was generated from its prompts.'
            : 'using the built-in rubric; generate a plan to tailor it.')
        : `Grading disabled for ${name} — its calls are no longer scored.`);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Grading change failed');
    } finally {
      setBusy(false);
    }
  };

  /** Ask the LLM for a fresh plan for this workflow (and publish it). */
  const regeneratePlan = async (workflow: GradableWorkflow) => {
    setBusy(true);
    setError(null);
    try {
      const res = await api.enableGrading(workflow.id, { enabled: true, regenerate: true });
      setPlanTarget({ ...workflow, grading: res.grading });
      flash(`New grading plan generated for ${workflow.name}.`);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Plan generation failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Workflows</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Dograh AI call workflows — create one from a description or template, edit its prompts,
            and bind it to an agent's phone number. Changes are written straight into dograh and
            published, so they go live the same way they would from the dograh editor.
          </p>
        </div>
        {configured && (
          <div className="flex items-center gap-4">
            <label className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
              <input
                type="checkbox"
                className="h-4 w-4 rounded border-muted-foreground/40"
                checked={showArchived}
                onChange={e => setShowArchived(e.target.checked)}
              />
              Show archived
            </label>
            <Button onClick={() => setCreateOpen(true)}>New workflow</Button>
          </div>
        )}
      </div>

      {notice && (
        <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-600 dark:text-emerald-400">
          {notice}
        </div>
      )}
      {error && (
        <div className="rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-600 dark:text-red-400">
          {error}
        </div>
      )}
      {gradingError && (
        <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-700 dark:text-amber-300">
          Couldn't load which workflows are graded ({gradingError}) — the Graded column is
          unavailable until the API is reachable.
        </div>
      )}

      {configured && mode === 'addon' && (
        <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-700 dark:text-amber-300">
          <span className="font-semibold">Add-on mode (Zeus shared PBX).</span>{' '}
          Workflows are created and published in dograh here; the shared box applies the
          PBX-side routing on its next reconcile.
        </div>
      )}

      <div className="overflow-hidden rounded-2xl border bg-card shadow-sm">
        {loading ? (
          <div className="flex items-center justify-center gap-3 p-10 text-sm text-muted-foreground">
            <Spinner className="h-4 w-4" /> Loading workflows…
          </div>
        ) : !configured ? (
          <div className="p-10 text-center text-sm text-muted-foreground">
            <p className="font-medium text-foreground">dograh isn't wired up yet.</p>
            <p className="mx-auto mt-2 max-w-xl">
              Run <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">scripts/dograh_wire.py</code> once to
              mint an API key, then set <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">DOGRAH_API_TOKEN</code> in
              .env and restart dashboard-api.
            </p>
          </div>
        ) : workflows.length === 0 ? (
          <div className="p-10 text-center text-sm text-muted-foreground">
            No workflows yet — create one to give an agent something to say.
          </div>
        ) : visibleWorkflows.length === 0 ? (
          <div className="p-10 text-center text-sm text-muted-foreground">
            All {workflows.length} workflow{workflows.length === 1 ? ' is' : 's are'} archived — tick
            <span className="font-medium text-foreground"> Show archived</span> to see them.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-muted/40 text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <th className="px-5 py-3 font-medium">Name</th>
                  <th className="px-5 py-3 font-medium">Status</th>
                  <th className="px-5 py-3 font-medium">Graded</th>
                  <th className="px-5 py-3 font-medium">Used by</th>
                  <th className="px-5 py-3 text-right font-medium">Actions</th>
                </tr>
              </thead>
              <tbody>
                {visibleWorkflows.map(w => {
                  const bound = agents.filter(a => a.workflowId === w.id);
                  const archived = w.status === 'archived';
                  const grading = gradingFor(w.id)?.grading ?? null;
                  return (
                    <tr key={w.id} className={cn('border-b last:border-0', archived && 'opacity-60')}>
                      <td className="px-5 py-3.5">
                        <span className="font-medium">{w.name}</span>
                        <span className="ml-2 font-mono text-xs text-muted-foreground">#{w.id}</span>
                      </td>
                      <td className="px-5 py-3.5">
                        <span
                          className={cn(
                            'rounded-md px-1.5 py-0.5 text-xs',
                            archived ? 'bg-muted text-muted-foreground' : 'bg-success/10 text-success',
                          )}
                        >
                          {w.status || 'active'}
                        </span>
                      </td>
                      <td className="px-5 py-3.5">
                        {grading === null ? (
                          <span className="text-xs text-muted-foreground">—</span>
                        ) : !grading.available ? (
                          <span className="text-xs text-muted-foreground" title={grading.error ?? 'Grading state unavailable'}>
                            unavailable
                          </span>
                        ) : (
                          <div className="flex flex-wrap items-center gap-2">
                            <label
                              className="inline-flex cursor-pointer items-center gap-2"
                              title={grading.enabled
                                ? 'Calls to this workflow are graded on hang-up.'
                                : grading.has_webhook
                                  ? 'Calls to this workflow are not graded.'
                                  : 'Calls to this workflow are not sent to the grader yet — ticking adds a post-call webhook so they can be graded.'}
                            >
                              <input
                                type="checkbox"
                                className="h-4 w-4 rounded border-muted-foreground/40"
                                checked={grading.enabled}
                                disabled={busy}
                                onChange={e => void toggleGrading(w.id, w.name, e.target.checked)}
                              />
                              <span
                                className={cn(
                                  'text-xs',
                                  grading.enabled ? 'text-success' : 'text-muted-foreground',
                                )}
                              >
                                {grading.enabled ? 'Graded' : 'Not graded'}
                              </span>
                            </label>
                            {!grading.has_webhook && (
                              <span
                                className="text-xs text-muted-foreground/80"
                                title="Ticking adds the grader's post-call webhook to this workflow in dograh."
                              >
                                adds a webhook
                              </span>
                            )}
                            {grading.enabled && (
                              <button
                                className="rounded-lg px-2 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50"
                                disabled={busy}
                                onClick={() => setPlanTarget(gradingFor(w.id))}
                              >
                                {grading.mode === 'custom' ? 'Plan' : 'Generate plan'}
                              </button>
                            )}
                            {grading.enabled && grading.webhook_enabled === false && (
                              <span
                                className="text-xs text-amber-600 dark:text-amber-400"
                                title="The webhook node is switched off in dograh, so the grader never receives the call."
                              >
                                webhook off
                              </span>
                            )}
                          </div>
                        )}
                      </td>
                      <td className="px-5 py-3.5">
                        {bound.length === 0 ? (
                          <span className="text-xs text-muted-foreground">—</span>
                        ) : (
                          <div className="flex flex-wrap gap-1.5">
                            {bound.map(a => (
                              <Link
                                key={a.id}
                                to={`/agents?agent=${a.id}`}
                                title={`Edit agent ${a.label}`}
                                className="inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground"
                              >
                                <span className="h-1.5 w-1.5 rounded-full bg-current" />
                                {a.label}
                                {(a.extension || a.address) && (
                                  <span className="font-mono text-[11px] text-muted-foreground/80">
                                    {a.extension || a.address}
                                  </span>
                                )}
                              </Link>
                            ))}
                          </div>
                        )}
                      </td>
                      <td className="px-5 py-3.5 text-right">
                        <div className="flex justify-end gap-2">
                          <button
                            className="rounded-lg px-2.5 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50"
                            disabled={busy}
                            onClick={() => void handleEdit(w.id)}
                          >
                            Edit prompts
                          </button>
                          <button
                            className={cn(
                              'rounded-lg px-2.5 py-1.5 text-xs font-medium transition-colors disabled:opacity-50',
                              archived
                                ? 'text-muted-foreground hover:bg-muted hover:text-foreground'
                                : 'text-amber-600 hover:bg-amber-500/10',
                            )}
                            disabled={busy}
                            onClick={() => void handleStatus(w, archived ? 'active' : 'archived')}
                          >
                            {archived ? 'Restore' : 'Archive'}
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <p className="text-xs text-muted-foreground">
        Bind a workflow to a phone number on the <span className="font-medium text-foreground">Agents</span> page —
        or create and bind it in one step from the agent's Add/Edit dialog.
      </p>

      {/* Create modal */}
      <Modal open={createOpen} onClose={() => setCreateOpen(false)} title="New workflow" size="xl">
        <WorkflowForm
          onCancel={() => setCreateOpen(false)}
          onSaved={wf => {
            setCreateOpen(false);
            flash(`Workflow ${wf.name} created and published in dograh — bind it to a phone number on the Agents page.`);
            void refresh();
          }}
        />
      </Modal>

      {/* Edit modal */}
      <Modal open={editTarget !== null} onClose={() => setEditTarget(null)}
        title={`Edit workflow — ${editTarget?.name ?? ''}`} size="xl">
        {editTarget && (
          <WorkflowForm
            workflow={editTarget}
            onCancel={() => setEditTarget(null)}
            onSaved={wf => {
              setEditTarget(null);
              flash(`Workflow ${wf.name} updated and published in dograh.`);
              void refresh();
            }}
          />
        )}
      </Modal>

      {/* Grading plan modal — what the LLM will score this workflow's calls on */}
      <Modal
        open={planTarget !== null && planGrading !== null}
        onClose={() => setPlanTarget(null)}
        title={`Grading plan — ${planTarget?.name ?? ''}`}
        size="xl"
      >
        {planTarget !== null && planGrading !== null && (
          <div className="space-y-4 text-sm">
            <div className="flex flex-wrap items-center gap-3">
              <span
                className={cn(
                  'rounded-md px-1.5 py-0.5 text-xs',
                  planGrading.mode === 'custom'
                    ? 'bg-success/10 text-success'
                    : 'bg-muted text-muted-foreground',
                )}
              >
                {planGrading.mode === 'custom'
                  ? 'generated plan'
                  : planGrading.mode === 'none' ? 'no webhook yet' : 'built-in rubric'}
              </span>
              {planGrading.meta?.title && (
                <span className="font-medium">{planGrading.meta.title}</span>
              )}
              {planGrading.meta?.generated_at && (
                <span className="text-xs text-muted-foreground">
                  {planGrading.meta.model || 'llm'} · {planGrading.meta.generated_at}
                </span>
              )}
            </div>

            {planDimensions.length > 0 && (
              <div className="overflow-hidden rounded-xl border">
                <table className="w-full text-xs">
                  <thead className="bg-muted/40 text-left uppercase tracking-wide text-muted-foreground">
                    <tr>
                      <th className="px-3 py-2 font-medium">Dimension</th>
                      <th className="px-3 py-2 font-medium">Weight</th>
                    </tr>
                  </thead>
                  <tbody>
                    {planDimensions.map(d => (
                      <tr key={d.key} className="border-t">
                        <td className="px-3 py-2">{d.label || d.key}</td>
                        <td className="px-3 py-2">{d.weight ?? '—'}%</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {planGrading.mode === 'custom' ? (
              <pre className="max-h-80 overflow-auto whitespace-pre-wrap rounded-xl border bg-muted/40 p-4 font-mono text-[11px] leading-relaxed">
                {planGrading.plan}
              </pre>
            ) : (
              <p className="rounded-xl border bg-muted/40 px-4 py-3 text-xs text-muted-foreground">
                This workflow is graded with the n8n grader's built-in rubric for its track.
                Generate a plan to score it against the scenarios in its own prompts instead.
              </p>
            )}

            <p className="text-xs text-muted-foreground">
              The plan is stored on the workflow's post-call webhook in dograh and published,
              so the next graded call uses it. Regenerating replaces the current plan.
            </p>

            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setPlanTarget(null)}>Close</Button>
              <Button disabled={busy} onClick={() => void regeneratePlan(planTarget)}>
                {planGrading.mode === 'custom' ? 'Regenerate plan' : 'Generate plan'}
              </Button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
