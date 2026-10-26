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
  Textarea,
  Input,
  useToast,
} from '../ui.jsx';

const STATUS_TONE = { active: 'success', paused: 'warning', draft: 'neutral' };
const STEP_TYPES = ['dial', 'transfer', 'voicemail', 'sms', 'email', 'webhook', 'tag', 'wait'];

const parseSteps = (text) =>
  text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [type, label, target] = line.split('|').map((part) => (part || '').trim());
      return { type, label, target };
    })
    .filter((step) => step.type);

const SAMPLE = 'dial | Ring the on-call rotation | 220\nwait | 30 second ring time | 30\nvoicemail | Fall back to voicemail | 220';

export default function Workflows() {
  const toast = useToast();
  const [items, setItems] = useState([]);
  const [summary, setSummary] = useState(null);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState('');
  const [form, setForm] = useState({ name: '', trigger: 'inbound', steps: SAMPLE });

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

  const create = async () => {
    setBusy('new');
    try {
      const data = await api.post('/workflows', { ...form, steps: parseSteps(form.steps) });
      setItems((list) => [...list, data.workflow]);
      load();
      setOpen(false);
      setForm({ name: '', trigger: 'inbound', steps: SAMPLE });
      toast.success('Workflow created', 'Activate it when the steps look right.');
    } catch (err) {
      toast.error('Could not create the workflow', err.message);
    } finally {
      setBusy('');
    }
  };

  const successRate = (workflow) =>
    workflow.runs ? Math.round((workflow.successCount / workflow.runs) * 100) : null;

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
        <Stat label="Step types" value={STEP_TYPES.length} foot="Validated on every run" />
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
            A workflow is a list of typed steps fired by an inbound call, schedule or webhook.
          </Empty>
        )}
      </Card>

      {open ? (
        <Modal
          title="New workflow"
          subtitle="One step per line: type | label | target"
          onClose={() => setOpen(false)}
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
            <Input label="Name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Missed call → SMS" />
            <Select label="Trigger" value={form.trigger} onChange={(e) => setForm({ ...form, trigger: e.target.value })}>
              <option value="inbound">Inbound call</option>
              <option value="outbound">Outbound call</option>
              <option value="schedule">Schedule</option>
              <option value="webhook">Webhook</option>
              <option value="manual">Manual</option>
            </Select>
            <Textarea
              label="Steps"
              rows={6}
              value={form.steps}
              onChange={(e) => setForm({ ...form, steps: e.target.value })}
              hint={`Types: ${STEP_TYPES.join(', ')}. An unknown type fails the run instead of silently passing.`}
            />
          </div>
        </Modal>
      ) : null}
    </>
  );
}
