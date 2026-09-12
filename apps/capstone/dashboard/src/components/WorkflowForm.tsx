import { useState } from 'react';
import { api, type Workflow, type WorkflowMode, type WorkflowNode } from '../lib/api';
import Button from './Button';
import Input from './Input';
import { cn } from '../lib/utils';

const NODE_LABELS: Record<string, string> = {
  globalNode: 'Agent persona',
  startCall: 'Opening & greeting',
  agentNode: 'Main script',
  endCall: 'Closing',
};

const NODE_HINTS: Record<string, string> = {
  globalNode: 'Prepended to every node — who the agent is and how it speaks.',
  startCall: 'How the call opens; the greeting is spoken verbatim first.',
  agentNode: 'The checklist of what to accomplish during the call.',
  endCall: 'How the agent wraps up and hangs up.',
};

const textareaClass =
  'w-full rounded-md border bg-background px-3 py-2 text-sm shadow-sm transition-colors placeholder:text-muted-foreground focus:border-primary focus:outline-none focus:ring-1 focus:ring-ring disabled:opacity-50';

const MODES: Array<{ id: WorkflowMode; label: string }> = [
  { id: 'ai', label: 'Describe it (AI)' },
  { id: 'guided', label: 'Guided template' },
  { id: 'blank', label: 'Blank' },
];

interface WorkflowFormProps {
  /** Existing workflow (with `nodes`) when editing; omitted when creating. */
  workflow?: Workflow | null;
  onSaved: (workflow: Workflow) => void;
  onCancel: () => void;
}

/**
 * Create a dograh workflow from a description/template, or edit the prompt
 * nodes of an existing one. Posts the same definition the dograh UI canvas
 * would, then the parent binds/wires the result.
 */
export default function WorkflowForm({ workflow, onSaved, onCancel }: WorkflowFormProps) {
  const editing = workflow != null;
  const [name, setName] = useState(workflow?.name ?? '');
  const [mode, setMode] = useState<WorkflowMode>('ai');
  const [description, setDescription] = useState('');
  const [useCase, setUseCase] = useState('inbound');
  const [role, setRole] = useState('');
  const [goal, setGoal] = useState('');
  const [script, setScript] = useState('');
  const [nodes, setNodes] = useState<WorkflowNode[]>(workflow?.nodes ?? []);
  // '' = dograh's default (no explicit limit), '0' = no limit, else seconds.
  const [duration, setDuration] = useState(
    workflow?.maxCallDuration == null ? '' : String(workflow.maxCallDuration),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /** '' -> undefined (unchanged); a valid number -> seconds; invalid -> null. */
  const durationSeconds = (): number | undefined | null => {
    const raw = duration.trim();
    if (raw === '') return undefined;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0 || Math.floor(n) !== n) return null;
    return n === workflow?.maxCallDuration ? undefined : n;
  };

  const updateNode = (id: string, patch: Partial<WorkflowNode>) => {
    setNodes(current => current.map(n => (n.id === id ? { ...n, ...patch } : n)));
  };

  const canSave = name.trim().length > 0 && (editing || mode !== 'ai' || description.trim().length > 0);

  const handleSave = async () => {
    if (!canSave) return;
    setBusy(true);
    setError(null);
    try {
      if (editing && workflow) {
        const seconds = durationSeconds();
        if (seconds === null) {
          setError('Call length must be a whole number of seconds (0 = no limit).');
          setBusy(false);
          return;
        }
        const saved = await api.updateWorkflow(workflow.id, {
          name: name.trim() !== workflow.name ? name.trim() : undefined,
          maxCallDuration: seconds,
          nodes: nodes.map(n => ({
            id: n.id,
            name: n.name,
            prompt: n.prompt,
            ...(n.greeting !== undefined ? { greeting: n.greeting } : {}),
          })),
        });
        onSaved(saved);
      } else {
        const created = await api.createWorkflow({
          name: name.trim(),
          mode,
          ...(mode === 'ai'
            ? { description: description.trim() }
            : mode === 'guided'
              ? { role: role.trim(), goal: goal.trim(), prompt: script.trim(), useCase }
              : { useCase }),
        });
        onSaved(created);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <div>
        <label className="text-sm font-medium">Workflow name</label>
        <Input
          className="mt-1"
          placeholder="Business Receptionist"
          value={name}
          onChange={e => setName(e.target.value.slice(0, 64))}
        />
        <p className="mt-1 text-xs text-muted-foreground">
          The trigger path is derived from this name; both appear in dograh.
        </p>
      </div>

      {!editing && (
        <>
          <div className="flex gap-1 rounded-lg border bg-muted/30 p-1">
            {MODES.map(m => (
              <button
                key={m.id}
                type="button"
                className={cn(
                  'flex-1 rounded-md px-2 py-1.5 text-xs font-medium transition-colors',
                  mode === m.id ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground',
                )}
                onClick={() => setMode(m.id)}
              >
                {m.label}
              </button>
            ))}
          </div>

          {mode === 'ai' && (
            <div>
              <label className="text-sm font-medium">Describe the agent</label>
              <textarea
                className={cn(textareaClass, 'mt-1 min-h-[70px]')}
                placeholder="e.g. a dental office that calls patients to remind them of appointments and offers to reschedule"
                value={description}
                onChange={e => setDescription(e.target.value)}
              />
              <p className="mt-1 text-xs text-muted-foreground">
                Expanded by the local OmniRoute gateway, then imported into dograh.
              </p>
            </div>
          )}

          {mode === 'guided' && (
            <>
              <div>
                <label className="text-sm font-medium">Agent role</label>
                <Input className="mt-1" placeholder="e.g. an appointment reminder caller"
                  value={role} onChange={e => setRole(e.target.value)} />
              </div>
              <div>
                <label className="text-sm font-medium">Overall goal</label>
                <Input className="mt-1" placeholder="e.g. confirm the appointment or reschedule it"
                  value={goal} onChange={e => setGoal(e.target.value)} />
              </div>
              <div>
                <label className="text-sm font-medium">What it should say / do</label>
                <textarea className={cn(textareaClass, 'mt-1 min-h-[70px]')}
                  placeholder="e.g. confirm identity, state the date and time, offer to reschedule, confirm the outcome"
                  value={script} onChange={e => setScript(e.target.value)} />
              </div>
            </>
          )}

          {mode !== 'ai' && (
            <div>
              <label className="text-sm font-medium">Use case</label>
              <select
                className="mt-1 w-full rounded-lg border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/40"
                value={useCase}
                onChange={e => setUseCase(e.target.value)}
              >
                <option value="inbound">inbound</option>
                <option value="outbound">outbound</option>
                <option value="survey">survey</option>
                <option value="interview">interview</option>
              </select>
            </div>
          )}

          {mode === 'blank' && (
            <p className="text-xs text-muted-foreground">
              Creates a minimal working agent you can flesh out on the dograh canvas.
            </p>
          )}
        </>
      )}

      {editing && (
        <div className="space-y-3">
          <div>
            <label className="text-sm font-medium">Call length limit</label>
            <div className="mt-1 flex gap-2">
              <Input
                type="number"
                min={0}
                step={1}
                placeholder="dograh default (300 s)"
                value={duration}
                onChange={e => setDuration(e.target.value)}
                className="w-44"
                disabled={busy}
              />
              <button
                type="button"
                className="rounded-md border px-3 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50"
                disabled={busy || duration === '0'}
                onClick={() => setDuration('0')}
              >
                No limit
              </button>
              <button
                type="button"
                className="rounded-md border px-3 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50"
                disabled={busy || duration === ''}
                onClick={() => setDuration('')}
              >
                Reset to default
              </button>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              Seconds before dograh ends the call. Leave empty for the deployment default
              (300 s); 0 lets the call run until the interview itself hangs up. Changes apply
              to the next call after saving.
            </p>
          </div>
          {nodes.length === 0 && (
            <p className="rounded-lg border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
              This workflow has no editable prompt nodes — open it on the dograh canvas to change its graph.
            </p>
          )}
          {nodes.map(node => (
            <div key={node.id} className="rounded-lg border bg-muted/20 p-3">
              <div className="flex items-center justify-between">
                <label className="text-sm font-medium">{NODE_LABELS[node.type] ?? node.type}</label>
                <span className="font-mono text-[11px] text-muted-foreground">{node.id}</span>
              </div>
              {node.greeting !== undefined && (
                <>
                  <label className="mt-2 block text-xs font-medium text-muted-foreground">Spoken greeting</label>
                  <textarea
                    className={cn(textareaClass, 'mt-1 min-h-[50px]')}
                    value={node.greeting}
                    onChange={e => updateNode(node.id, { greeting: e.target.value })}
                  />
                </>
              )}
              <label className="mt-2 block text-xs font-medium text-muted-foreground">Prompt</label>
              <textarea
                className={cn(textareaClass, 'mt-1 min-h-[90px] font-mono text-xs')}
                value={node.prompt}
                onChange={e => updateNode(node.id, { prompt: e.target.value })}
              />
              {NODE_HINTS[node.type] && (
                <p className="mt-1 text-xs text-muted-foreground">{NODE_HINTS[node.type]}</p>
              )}
            </div>
          ))}
          {nodes.length > 0 && (
            <p className="text-xs text-muted-foreground">
              Saving writes the definition to dograh and publishes it, so calls to any agent using
              this workflow pick the change up immediately.
            </p>
          )}
        </div>
      )}

      {error && (
        <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-600 dark:text-red-400">
          {error}
        </div>
      )}

      <div className="flex justify-end gap-2 pt-1">
        <Button variant="ghost" onClick={onCancel} disabled={busy}>Cancel</Button>
        <Button onClick={() => void handleSave()} disabled={busy || !canSave}>
          {busy ? 'Saving…' : editing ? 'Save & publish' : 'Create workflow'}
        </Button>
      </div>
    </div>
  );
}
