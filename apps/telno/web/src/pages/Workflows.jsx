import { useEffect, useState } from 'react';
import { api, relativeTime } from '../api.js';
import {
  Badge,
  Button,
  Card,
  Empty,
  Loading,
  Modal,
  PageHeader,
  Select,
  Stat,
  Input,
  useToast,
} from '../ui.jsx';

const STATUS_TONE = { active: 'success', paused: 'warning', draft: 'neutral' };

const emptyStep = () => ({ type: 'dial', label: '', target: '' });

/**
 * Workflows, built from recipes rather than from a mini-language.
 *
 * The old form asked for `dial | Ring the desk | 220` one line at a time, and a
 * typo was a silent failure. Now a recipe creates a working flow in one click,
 * each step is a row with a picker for its kind, and every field stays editable
 * afterwards. The raw syntax has not gone away — it is what gets saved — but
 * nobody has to recall it to build an automation.
 */
export default function Workflows() {
  const toast = useToast();
  const [items, setItems] = useState([]);
  const [summary, setSummary] = useState(null);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState('');
  const [catalog, setCatalog] = useState({ workflows: [], triggers: [], stepTypes: [], agents: [], voices: [], languages: [] });
  const [form, setForm] = useState({ name: '', trigger: 'inbound', steps: [emptyStep()] });

  const load = async () => {
    try {
      const data = await api.get('/workflows');
      setItems(data.items);
      setSummary(data.summary);
    } catch (err) {
      toast.error('Could not load workflows', err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    api
      .get('/presets')
      .then((data) => setCatalog(data))
      .catch(() => {
        /* the editor still works with a picker and no recipes */
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const replace = (workflow) => setItems((list) => list.map((item) => (item.id === workflow.id ? workflow : item)));

  const run = async (workflow) => {
    setBusy(workflow.id);
    try {
      const data = await api.post(`/workflows/${workflow.id}/run`, {});
      replace(data.workflow);
      load();
      if (data.ok) toast.success(`${workflow.name} ran`, `${data.workflow.steps.length} steps completed.`);
      else toast.error('Run failed', 'A step type is not recognized. Fix the flow and run again.');
    } catch (err) {
      toast.error('Could not run the workflow', err.message);
    } finally {
      setBusy('');
    }
  };

  const setStatus = async (workflow, status) => {
    setBusy(workflow.id);
    try {
      const data = await api.patch(`/workflows/${workflow.id}`, { status });
      replace(data.workflow);
      load();
      toast.success(`${workflow.name} is ${status}`);
    } catch (err) {
      toast.error('Could not update the workflow', err.message);
    } finally {
      setBusy('');
    }
  };

  const remove = async (workflow) => {
    if (!window.confirm(`Delete ${workflow.name}?`)) return;
    setBusy(workflow.id);
    try {
      await api.del(`/workflows/${workflow.id}`);
      setItems((list) => list.filter((item) => item.id !== workflow.id));
      load();
      toast.success('Workflow deleted');
    } catch (err) {
      toast.error('Could not delete the workflow', err.message);
    } finally {
      setBusy('');
    }
  };

  const applyRecipe = (id) => {
    const recipe = (catalog.workflows || []).find((entry) => entry.id === id);
    if (!recipe) return;
    setForm({
      name: recipe.name,
      trigger: recipe.trigger,
      steps: recipe.steps.map((step) => ({ ...step })),
    });
  };

  const updateStep = (index, patch) =>
    setForm((current) => ({
      ...current,
      steps: current.steps.map((step, i) => (i === index ? { ...step, ...patch } : step)),
    }));

  const create = async () => {
    setBusy('new');
    try {
      const steps = form.steps.filter((step) => step.type);
      if (!steps.length) {
        toast.error('Add at least one step', 'A workflow with no steps has nothing to do.');
        return;
      }
      const data = await api.post('/workflows', { name: form.name, trigger: form.trigger, steps });
      setItems((list) => [...list, data.workflow]);
      load();
      setOpen(false);
      setForm({ name: '', trigger: 'inbound', steps: [emptyStep()] });
      toast.success('Workflow created', 'Activate it when the steps look right.');
    } catch (err) {
      toast.error('Could not create the workflow', err.message);
    } finally {
      setBusy('');
    }
  };

  const successRate = (workflow) =>
    workflow.runs ? Math.round((workflow.successCount / workflow.runs) * 100) : null;

  const typeLabel = (type) => (catalog.stepTypes || []).find((entry) => entry.type === type)?.label || type;

  return (
    <>
      <PageHeader
        title="Workflows"
        subtitle="Triggered automations over the same registry and switch — every run is recorded"
        actions={<Button variant="primary" icon="plus" onClick={() => setOpen(true)}>New workflow</Button>}
      />

      <div className="grid stats">
        <Stat label="Active" value={summary?.active ?? '—'} foot={`${items.length} total`} />
        <Stat label="Runs" value={summary?.runs?.toLocaleString() ?? '—'} foot="All time" />
        <Stat label="Failing" value={summary?.failing ?? '—'} foot="Last run failed" tone={summary?.failing ? 'var(--danger)' : undefined} />
        <Stat label="Recipes" value={(catalog.workflows || []).length} foot="Ready-made starting points" />
      </div>

      <Card bodyClass="tight">
        {loading ? (
          <div style={{ padding: 16 }}><Loading rows={4} /></div>
        ) : items.length ? (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Workflow</th>
                  <th>Trigger</th>
                  <th>Steps</th>
                  <th className="align-right">Runs</th>
                  <th className="align-right">Success</th>
                  <th>Last run</th>
                  <th>Status</th>
                  <th className="align-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {items.map((workflow) => (
                  <tr key={workflow.id}>
                    <td>
                      <strong style={{ fontSize: '0.8125rem' }}>{workflow.name}</strong>
                      <div className="tiny dim">{workflow.steps.map((step) => step.type).join(' → ')}</div>
                    </td>
                    <td><span className="tiny mono">{workflow.trigger}</span></td>
                    <td className="tiny dim">{workflow.steps.length}</td>
                    <td className="align-right tiny mono">{workflow.runs.toLocaleString()}</td>
                    <td className="align-right tiny mono">
                      {successRate(workflow) === null ? '—' : `${successRate(workflow)}%`}
                    </td>
                    <td className="tiny dim nowrap" title={workflow.lastRunAt || ''}>
                      {workflow.lastRunAt ? relativeTime(workflow.lastRunAt) : 'never'}
                    </td>
                    <td><Badge tone={STATUS_TONE[workflow.status]}>{workflow.status}</Badge></td>
                    <td className="align-right">
                      <div className="row" style={{ gap: 4, justifyContent: 'flex-end' }}>
                        <Button
                          size="sm"
                          variant="ghost"
                          icon="play"
                          disabled={workflow.status !== 'active'}
                          loading={busy === workflow.id}
                          onClick={() => run(workflow)}
                          title={workflow.status === 'active' ? 'Run now' : 'Activate first'}
                        >
                          Run
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => setStatus(workflow, workflow.status === 'active' ? 'paused' : 'active')}
                          loading={busy === workflow.id}
                        >
                          {workflow.status === 'active' ? 'Pause' : 'Activate'}
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          icon="trash"
                          loading={busy === workflow.id}
                          onClick={() => remove(workflow)}
                          aria-label={`Delete ${workflow.name}`}
                        />
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty icon="flow" title="No workflows yet" action={<Button variant="primary" onClick={() => setOpen(true)}>Build one</Button>}>
            Start from a recipe — missed-call text-back, after-hours, escalation — and edit the steps it gives you.
          </Empty>
        )}
      </Card>

      {open ? (
        <Modal
          title="New workflow"
          subtitle="Start from a recipe, then change anything you like"
          onClose={() => setOpen(false)}
          wide
          footer={
            <>
              <Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
              <Button variant="primary" loading={busy === 'new'} disabled={!form.name.trim()} onClick={create}>
                Create workflow
              </Button>
            </>
          }
        >
          <div className="stack">
            <Select label="Recipe" value="" onChange={(event) => applyRecipe(event.target.value)}>
              <option value="">Choose a starting point…</option>
              {(catalog.workflows || []).map((recipe) => (
                <option key={recipe.id} value={recipe.id}>{recipe.name}</option>
              ))}
            </Select>
            {(catalog.workflows || []).length ? (
              <p className="tiny dim">
                A recipe fills the name, trigger and steps below. Nothing is locked: every field stays editable, and
                what is created is an ordinary workflow.
              </p>
            ) : null}

            <div className="grid two">
              <Input label="Name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Missed call → text back" />
              <Select label="Trigger" value={form.trigger} onChange={(e) => setForm({ ...form, trigger: e.target.value })}>
                {(catalog.triggers || [{ value: 'inbound', label: 'An inbound call arrives' }]).map((trigger) => (
                  <option key={trigger.value} value={trigger.value}>{trigger.label}</option>
                ))}
              </Select>
            </div>

            <div className="stack" style={{ gap: 8 }}>
              <span className="field-label">Steps</span>
              {form.steps.map((step, index) => (
                <div key={index} className="card" style={{ padding: 10 }}>
                  <div className="grid two" style={{ gap: 8 }}>
                    <Select
                      label="Do this"
                      value={step.type}
                      onChange={(event) => updateStep(index, { type: event.target.value })}
                    >
                      {(catalog.stepTypes || [{ type: 'dial', label: 'Call a number or extension' }]).map((entry) => (
                        <option key={entry.type} value={entry.type}>{entry.label}</option>
                      ))}
                    </Select>
                    <Input
                      label="Target"
                      value={step.target}
                      onChange={(event) => updateStep(index, { target: event.target.value })}
                      placeholder={step.type === 'wait' ? '30' : step.type === 'email' ? 'team@example.com' : step.type === 'webhook' ? 'https://…' : '220'}
                      className="mono"
                    />
                  </div>
                  <div className="row" style={{ gap: 8, marginTop: 8, alignItems: 'flex-end' }}>
                    <div style={{ flex: 1 }}>
                      <Input
                        label="What it does"
                        value={step.label}
                        onChange={(event) => updateStep(index, { label: event.target.value })}
                        placeholder={typeLabel(step.type)}
                      />
                    </div>
                    <Button
                      size="sm"
                      variant="ghost"
                      icon="trash"
                      aria-label="Remove step"
                      disabled={form.steps.length === 1}
                      onClick={() => setForm((current) => ({ ...current, steps: current.steps.filter((_, i) => i !== index) }))}
                    />
                  </div>
                </div>
              ))}
              <Button size="sm" variant="ghost" icon="plus" onClick={() => setForm((current) => ({ ...current, steps: [...current.steps, emptyStep()] }))}>
                Add a step
              </Button>
            </div>
          </div>
        </Modal>
      ) : null}
    </>
  );
}
