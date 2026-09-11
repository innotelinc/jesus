import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, type Agent, type AgentWorkflow, type StasisHealth, type Workflow } from '../lib/api';
import Button from '../components/Button';
import Input from '../components/Input';
import Modal from '../components/Modal';
import Spinner from '../components/Spinner';
import WorkflowForm from '../components/WorkflowForm';
import { cn } from '../lib/utils';

function ModeBanner({ mode }: { mode: 'standalone' | 'addon' }) {
  if (mode === 'addon') {
    return (
      <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-700 dark:text-amber-300">
        <span className="font-semibold">Add-on mode (Zeus shared PBX).</span>{' '}
        Agents are managed here and on dograh; the shared box's reconcile applies the
        <code className="mx-1 rounded bg-muted px-1 py-0.5 font-mono text-xs">_custom.conf</code>
        moniker (<code className="mx-1 rounded bg-muted px-1 py-0.5 font-mono text-xs">extensions_custom_dograh.conf</code>),
        so agents show <span className="font-medium">pending-sync</span> until it runs.
      </div>
    );
  }
  return (
    <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-700 dark:text-emerald-300">
      <span className="font-semibold">Standalone mode.</span> Adding, editing, or deleting an agent
      wires the FreePBX side too — custom extension, inbound route, and dialplan — then reloads the PBX live.
    </div>
  );
}

/** Warn when the generated dialplan routes into an ARI app that isn't registered.
 *  numbers beyond 8000-8007 call `Stasis(<app>)`; an unregistered app means
 *  Asterisk hangs the channel up immediately — the call rings then drops. */
function StasisBanner({ stasis }: { stasis?: StasisHealth }) {
  if (!stasis || stasis.ok !== false) return null;
  return (
    <div className="rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-600 dark:text-red-400">
      <p className="font-semibold">
        Calls to {stasis.dynamicExtensions.join(', ')} will drop: the dialplan's Stasis app isn't registered.
      </p>
      <p className="mt-1">
        {stasis.detail ??
          `Extensions_custom_dograh.conf routes into Stasis(${stasis.expected}), but Asterisk has no ARI ` +
          `application by that name.`}
      </p>
      <p className="mt-1 text-xs opacity-90">
        Dialplan app: <code className="rounded bg-muted px-1 py-0.5 font-mono">{stasis.expected}</code>
        {' · '}registered:{' '}
        <code className="rounded bg-muted px-1 py-0.5 font-mono">
          {stasis.registered.length ? stasis.registered.join(', ') : 'none'}
        </code>
      </p>
    </div>
  );
}

function PbxChip({ status }: { status?: NonNullable<Agent['pbx']>['status'] }) {
  const map: Record<string, { label: string; cls: string }> = {
    provisioned: { label: 'Provisioned', cls: 'border-success/40 text-success' },
    partial: { label: 'Partial', cls: 'border-warning/40 text-warning' },
    'not-provisioned': { label: 'Not provisioned', cls: 'border-muted-foreground/30 text-muted-foreground' },
    'pending-sync': { label: 'Pending sync', cls: 'border-info/40 text-info' },
    error: { label: 'PBX error', cls: 'border-red-500/40 text-red-500' },
  };
  const m = map[status ?? 'not-provisioned'] ?? map['not-provisioned'];
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium',
        m.cls,
      )}
      title={status}
    >
      <span className="h-1.5 w-1.5 rounded-full bg-current" />
      {m.label}
    </span>
  );
}

export default function Agents() {
  const [mode, setMode] = useState<'standalone' | 'addon'>('standalone');
  const [configured, setConfigured] = useState(true);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [stasis, setStasis] = useState<StasisHealth | undefined>();
  const [workflows, setWorkflows] = useState<AgentWorkflow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [createOpen, setCreateOpen] = useState(false);
  const [newAddress, setNewAddress] = useState('');
  const [newLabel, setNewLabel] = useState('');
  const [newWorkflow, setNewWorkflow] = useState('');
  const [busy, setBusy] = useState<string | null>(null);

  const [editAgent, setEditAgent] = useState<Agent | null>(null);
  const [editLabel, setEditLabel] = useState('');
  const [editWorkflow, setEditWorkflow] = useState('');
  const [editActive, setEditActive] = useState(true);

  // Inline workflow authoring: create a new workflow while adding an agent, or
  // edit the prompts of the workflow bound to the agent being edited. Both
  // write to dograh exactly as its own editor would, then rebind here.
  const [createWorkflowOpen, setCreateWorkflowOpen] = useState(false);
  const [editWorkflowData, setEditWorkflowData] = useState<Workflow | null>(null);
  const [workflowLoading, setWorkflowLoading] = useState(false);

  // Deep link from the Workflows page: /agents?agent=<id> opens that agent.
  const [searchParams] = useSearchParams();
  const openedAgentParam = useRef<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.agents();
      setMode(res.mode);
      setConfigured(res.configured);
      setAgents(res.agents);
      setStasis(res.stasis);
      if (!res.configured && res.error) {
        setError(res.error);
      }
      if (res.configured) {
        api.agentWorkflows().then(setWorkflows).catch(() => setWorkflows([]));
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load agents');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const flash = (msg: string) => {
    setNotice(msg);
    window.setTimeout(() => setNotice(null), 5000);
  };

  const showWarnings = (warnings: string[] | undefined, fallback: string) => {
    if (warnings && warnings.length > 0) {
      flash(warnings.join(' '));
    } else {
      flash(fallback);
    }
  };

  const handleCreate = async () => {
    if (!newAddress.trim() || !newLabel.trim()) return;
    setBusy('create');
    setError(null);
    try {
      const workflowId = newWorkflow ? Number(newWorkflow) : null;
      const res = await api.createAgent({
        address: newAddress.trim(),
        label: newLabel.trim(),
        workflowId,
      });
      setCreateOpen(false);
      setCreateWorkflowOpen(false);
      setNewAddress(''); setNewLabel(''); setNewWorkflow('');
      showWarnings(res.warnings, `Agent ${res.agent.label} created and wired into the PBX`);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Create failed');
    } finally {
      setBusy(null);
    }
  };

  const openEdit = (agent: Agent) => {
    setEditAgent(agent);
    setEditLabel(agent.label);
    setEditWorkflow(agent.workflowId != null ? String(agent.workflowId) : '');
    setEditActive(agent.active);
    setEditWorkflowData(null);
  };

  const reloadWorkflowOptions = async () => {
    try {
      setWorkflows(await api.agentWorkflows());
    } catch {
      // the agent save still works; the option list is just stale
    }
  };

  const openEditWorkflow = async () => {
    if (!editAgent?.workflowId) return;
    setWorkflowLoading(true);
    setError(null);
    try {
      setEditWorkflowData(await api.workflow(editAgent.workflowId));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load workflow');
    } finally {
      setWorkflowLoading(false);
    }
  };

  useEffect(() => {
    const raw = searchParams.get('agent');
    if (!raw || openedAgentParam.current === raw || agents.length === 0) return;
    const agent = agents.find(a => String(a.id) === raw);
    if (!agent) return;
    openedAgentParam.current = raw;
    openEdit(agent);
    // openEdit is stable in effect here; it only runs once per ?agent= value.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams, agents]);

  const handleSaveEdit = async () => {
    if (!editAgent) return;
    setBusy(String(editAgent.id));
    setError(null);
    try {
      const body: { label?: string; workflowId?: number | null; active?: boolean } = {};
      if (editLabel.trim() && editLabel.trim() !== editAgent.label) body.label = editLabel.trim();
      const wf = editWorkflow ? Number(editWorkflow) : null;
      if (wf !== (editAgent.workflowId ?? null)) body.workflowId = wf;
      if (editActive !== editAgent.active) body.active = editActive;
      const res = await api.updateAgent(editAgent.id, body);
      setEditAgent(null);
      showWarnings(res.warnings, `Agent ${editAgent.label} updated`);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Update failed');
    } finally {
      setBusy(null);
    }
  };

  const handleDelete = async (agent: Agent) => {
    if (!window.confirm(
      `Delete agent ${agent.label} (extension ${agent.extension})? Its dograh number and FreePBX extension/inbound route will be removed.`)) return;
    setBusy(String(agent.id));
    setError(null);
    try {
      const res = await api.deleteAgent(agent.id);
      showWarnings(res.warnings, `Agent ${agent.label} deleted`);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Delete failed');
    } finally {
      setBusy(null);
    }
  };

  const toggleActive = async (agent: Agent) => {
    setBusy(String(agent.id));
    setError(null);
    try {
      await api.updateAgent(agent.id, { active: !agent.active });
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Toggle failed');
    } finally {
      setBusy(null);
    }
  };

  // Archived workflows aren't offered for new bindings; the one already bound
  // to the agent being edited stays listed so the selector never goes blank.
  const bindableWorkflows = workflows.filter(w => w.status !== 'archived');
  const editWorkflowChoices = workflows.filter(
    w => w.status !== 'archived' || String(w.id) === String(editAgent?.workflowId ?? ''),
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Agents</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Dograh AI voice agents — choose, add, edit, or delete. Each agent is a phone
            number whose calls are answered by an AI workflow instead of a human, routed
            through FreePBX.
          </p>
        </div>
        {configured && (
          <Button onClick={() => { setCreateWorkflowOpen(false); setCreateOpen(true); }} disabled={!configured}>Add agent</Button>
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

      {configured && <StasisBanner stasis={stasis} />}

      {configured && <ModeBanner mode={mode} />}

      <div className="overflow-hidden rounded-2xl border bg-card shadow-sm">
        {loading ? (
          <div className="flex items-center justify-center gap-3 p-10 text-sm text-muted-foreground">
            <Spinner className="h-4 w-4" /> Loading agents…
          </div>
        ) : !configured ? (
          <div className="p-10 text-center text-sm text-muted-foreground">
            <p className="font-medium text-foreground">dograh isn't wired up yet.</p>
            <p className="mx-auto mt-2 max-w-xl">
              Run <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">scripts/dograh_wire.py</code> once to
              mint an API key, then set <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">DOGRAH_API_TOKEN</code> in
              .env and restart dashboard-api. Agents are the phone numbers on the
              <em> Asterisk ARI (dograh)</em> telephony config.
            </p>
          </div>
        ) : agents.length === 0 ? (
          <div className="p-10 text-center text-sm text-muted-foreground">
            No agents yet — add one to point a number at a dograh workflow.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-muted/40 text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <th className="px-5 py-3 font-medium">Extension / DID</th>
                  <th className="px-5 py-3 font-medium">Label</th>
                  <th className="px-5 py-3 font-medium">Workflow</th>
                  <th className="px-5 py-3 font-medium">Status</th>
                  <th className="px-5 py-3 font-medium">Active</th>
                  <th className="px-5 py-3 text-right font-medium">Actions</th>
                </tr>
              </thead>
              <tbody>
                {agents.map(agent => (
                  <tr key={agent.id} className="border-b last:border-0">
                    <td className="px-5 py-3.5">
                      <span className="font-mono font-semibold">{agent.extension || agent.address || '—'}</span>
                      {agent.address && agent.address !== agent.extension && (
                        <span className="ml-2 font-mono text-xs text-muted-foreground">{agent.address}</span>
                      )}
                    </td>
                    <td className="px-5 py-3.5">{agent.label}</td>
                    <td className="px-5 py-3.5">
                      {agent.workflowName ? (
                        agent.workflowId != null ? (
                          <Link
                            to={`/workflows?workflow=${agent.workflowId}`}
                            title="Edit this workflow"
                            className="rounded-md bg-muted px-1.5 py-0.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
                          >
                            {agent.workflowName}
                          </Link>
                        ) : (
                          <span className="rounded-md bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
                            {agent.workflowName}
                          </span>
                        )
                      ) : (
                        <span className="text-xs text-muted-foreground">—</span>
                      )}
                    </td>
                    <td className="px-5 py-3.5">
                      <PbxChip status={agent.pbx?.status} />
                      {agent.pbx?.detail && (
                        <div className="mt-1 max-w-[260px] text-xs text-muted-foreground" title={agent.pbx.detail}>
                          {agent.pbx.detail.length > 90 ? `${agent.pbx.detail.slice(0, 90)}…` : agent.pbx.detail}
                        </div>
                      )}
                    </td>
                    <td className="px-5 py-3.5">
                      <button
                        className={cn(
                          'relative h-5 w-9 rounded-full transition-colors disabled:opacity-50',
                          agent.active ? 'bg-success/70' : 'bg-muted',
                        )}
                        disabled={busy === String(agent.id)}
                        title={agent.active ? 'Active — click to pause' : 'Paused — click to activate'}
                        onClick={() => void toggleActive(agent)}
                      >
                        <span
                          className={cn(
                            'absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-all',
                            agent.active ? 'left-[18px]' : 'left-0.5',
                          )}
                        />
                      </button>
                    </td>
                    <td className="px-5 py-3.5 text-right">
                      <div className="flex justify-end gap-2">
                        <button
                          className="rounded-lg px-2.5 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50"
                          disabled={busy === String(agent.id)}
                          onClick={() => openEdit(agent)}
                        >
                          Edit
                        </button>
                        <button
                          className="rounded-lg px-2.5 py-1.5 text-xs font-medium text-red-600 transition-colors hover:bg-red-500/10 disabled:opacity-50"
                          disabled={busy === String(agent.id)}
                          onClick={() => void handleDelete(agent)}
                        >
                          Delete
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {configured && (
        <p className="text-xs text-muted-foreground">
          {agents.filter(a => a.active).length}/{agents.length} agents active. Extensions 8000–8007 live in the static
          dialplan; numbers outside that set are written to{' '}
          <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">extensions_custom_dograh.conf</code> automatically.
          In standalone mode every change reloads FreePBX live; in add-on mode the shared box syncs them.
        </p>
      )}

      {/* Create modal */}
      <Modal open={createOpen} onClose={() => { setCreateOpen(false); setCreateWorkflowOpen(false); }} title="Add agent" size="xl">
        <div className="space-y-4">
          <div>
            <label className="text-sm font-medium">Phone number / extension</label>
            <Input className="mt-1" placeholder="8008 or +12125551234" value={newAddress}
              onChange={e => setNewAddress(e.target.value)} />
            <p className="mt-1 text-xs text-muted-foreground">
              Digits only are fine — dograh stores it verbatim and the dashboard derives the extension.
            </p>
          </div>
          <div>
            <label className="text-sm font-medium">Label</label>
            <Input className="mt-1" placeholder="Business Receptionist" value={newLabel}
              onChange={e => setNewLabel(e.target.value.slice(0, 64))} />
          </div>
          <div>
            <div className="flex items-center justify-between">
              <label className="text-sm font-medium">Workflow</label>
              {!createWorkflowOpen && (
                <button
                  type="button"
                  className="text-xs font-medium text-primary hover:underline"
                  onClick={() => setCreateWorkflowOpen(true)}
                >
                  + Create new workflow
                </button>
              )}
            </div>
            {createWorkflowOpen ? (
              <div className="mt-2 rounded-xl border bg-muted/20 p-3">
                <WorkflowForm
                  onCancel={() => setCreateWorkflowOpen(false)}
                  onSaved={wf => {
                    setCreateWorkflowOpen(false);
                    setNewWorkflow(String(wf.id));
                    void reloadWorkflowOptions();
                    flash(`Workflow ${wf.name} created in dograh and selected for this agent.`);
                  }}
                />
              </div>
            ) : (
              <>
                <select
                  className="mt-1 w-full rounded-lg border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/40"
                  value={newWorkflow}
                  onChange={e => setNewWorkflow(e.target.value)}
                >
                  <option value="">— no inbound workflow (outbound only) —</option>
                  {bindableWorkflows.map(w => (
                    <option key={w.id} value={String(w.id)}>{w.name}</option>
                  ))}
                </select>
                <p className="mt-1 text-xs text-muted-foreground">
                  Calls to this number run this workflow. Create one here — describe it, or use the
                  guided template — and it's imported into dograh automatically, or pick one that
                  already exists (<code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">/api/v1/workflow/fetch</code>).
                </p>
              </>
            )}
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="ghost" onClick={() => setCreateOpen(false)}>Cancel</Button>
            <Button onClick={() => void handleCreate()} disabled={busy === 'create' || !newAddress.trim() || !newLabel.trim()}>
              {busy === 'create' ? 'Creating…' : 'Create agent'}
            </Button>
          </div>
        </div>
      </Modal>

      {/* Edit modal */}
      <Modal open={editAgent !== null} onClose={() => { setEditAgent(null); setEditWorkflowData(null); }}
        title={`Edit agent — ${editAgent?.label ?? ''}`} size="xl">
        {editAgent && (
          <div className="space-y-4">
            <div>
              <label className="text-sm font-medium">Label</label>
              <Input className="mt-1" value={editLabel}
                onChange={e => setEditLabel(e.target.value.slice(0, 64))} />
            </div>
            <div>
              <div className="flex items-center justify-between">
                <label className="text-sm font-medium">Workflow</label>
                {editWorkflowData === null && editAgent.workflowId != null && (
                  <button
                    type="button"
                    className="text-xs font-medium text-primary hover:underline disabled:opacity-50"
                    disabled={workflowLoading}
                    onClick={() => void openEditWorkflow()}
                  >
                    {workflowLoading ? 'Loading…' : 'Edit workflow prompts'}
                  </button>
                )}
              </div>
              {editWorkflowData ? (
                <div className="mt-2 rounded-xl border bg-muted/20 p-3">
                  <WorkflowForm
                    workflow={editWorkflowData}
                    onCancel={() => setEditWorkflowData(null)}
                    onSaved={wf => {
                      setEditWorkflowData(null);
                      setEditWorkflow(String(wf.id));
                      void reloadWorkflowOptions();
                      flash(`Workflow ${wf.name} updated and published in dograh.`);
                    }}
                  />
                </div>
              ) : (
                <>
                  <select
                    className="mt-1 w-full rounded-lg border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/40"
                    value={editWorkflow}
                    onChange={e => setEditWorkflow(e.target.value)}
                  >
                    <option value="">— no inbound workflow (outbound only) —</option>
                    {editWorkflowChoices.map(w => (
                      <option key={w.id} value={String(w.id)}>
                        {w.name}{w.status === 'archived' ? ' (archived)' : ''}
                      </option>
                    ))}
                  </select>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Edit the workflow's persona/greeting/script right here, or re-point the number at
                    another one. The number itself is immutable in dograh — to renumber an agent,
                    delete it and create a new one.
                  </p>
                </>
              )}
            </div>
            <label className="flex items-center gap-2 text-sm font-medium">
              <input
                type="checkbox"
                className="h-4 w-4 rounded border-muted-foreground/40"
                checked={editActive}
                onChange={e => setEditActive(e.target.checked)}
              />
              Active — accept calls on this number
            </label>
            <div className="flex justify-end gap-2 pt-2">
              <Button variant="ghost" onClick={() => setEditAgent(null)}>Cancel</Button>
              <Button onClick={() => void handleSaveEdit()} disabled={busy === String(editAgent.id)}>
                {busy === String(editAgent.id) ? 'Saving…' : 'Save changes'}
              </Button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}