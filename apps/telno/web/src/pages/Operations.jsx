import { useEffect, useState } from 'react';
import { api, relativeTime } from '../api.js';
import {
  Badge,
  Button,
  Card,
  Empty,
  Input,
  Loading,
  Modal,
  PageHeader,
  Select,
  Stat,
  useToast,
} from '../ui.jsx';

const COLUMNS = [
  { status: 'open', label: 'Open' },
  { status: 'in_progress', label: 'In progress' },
  { status: 'blocked', label: 'Blocked' },
  { status: 'done', label: 'Done' },
];

const PRIORITY_TONE = { critical: 'danger', high: 'warning', normal: 'info', low: 'neutral' };
const NEXT = { open: 'in_progress', in_progress: 'done', blocked: 'open', done: 'open' };
const NEXT_LABEL = { open: 'Start', in_progress: 'Complete', blocked: 'Reopen', done: 'Reopen' };

export default function Operations() {
  const toast = useToast();
  const [items, setItems] = useState([]);
  const [summary, setSummary] = useState(null);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState('');
  const [form, setForm] = useState({ title: '', kind: 'maintenance', priority: 'normal', assignee: '', dueAt: '', note: '' });

  const load = async () => {
    try {
      const data = await api.get('/operations/tasks');
      setItems(data.items);
      setSummary(data.summary);
    } catch (err) {
      toast.error('Could not load tasks', err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const advance = async (task) => {
    setBusy(task.id);
    try {
      const data = await api.patch(`/operations/tasks/${task.id}`, { status: NEXT[task.status] });
      setItems((list) => list.map((item) => (item.id === task.id ? data.task : item)));
      load();
    } catch (err) {
      toast.error('Could not move the task', err.message);
    } finally {
      setBusy('');
    }
  };

  const remove = async (task) => {
    setBusy(task.id);
    try {
      await api.del(`/operations/tasks/${task.id}`);
      setItems((list) => list.filter((item) => item.id !== task.id));
      load();
      toast.success('Task deleted');
    } catch (err) {
      toast.error('Could not delete the task', err.message);
    } finally {
      setBusy('');
    }
  };

  const create = async () => {
    setBusy('new');
    try {
      const data = await api.post('/operations/tasks', form);
      setItems((list) => [data.task, ...list]);
      load();
      setOpen(false);
      setForm({ title: '', kind: 'maintenance', priority: 'normal', assignee: '', dueAt: '', note: '' });
      toast.success('Task created');
    } catch (err) {
      toast.error('Could not create the task', err.message);
    } finally {
      setBusy('');
    }
  };

  const overdue = (task) =>
    task.status !== 'done' && task.dueAt && new Date(task.dueAt).getTime() < Date.now();

  return (
    <>
      <PageHeader
        title="Operations"
        subtitle="Change, incident and provisioning work — one queue instead of three inboxes"
        actions={<Button variant="primary" icon="plus" onClick={() => setOpen(true)}>New task</Button>}
      />

      <div className="grid stats">
        <Stat label="Open" value={summary?.open ?? '—'} foot="Not started" />
        <Stat label="In progress" value={summary?.inProgress ?? '—'} foot="Being worked" />
        <Stat label="Blocked" value={summary?.blocked ?? '—'} foot="Waiting on something" tone={summary?.blocked ? 'var(--warning)' : undefined} />
        <Stat label="Overdue" value={summary?.overdue ?? '—'} foot="Past the due date" tone={summary?.overdue ? 'var(--danger)' : undefined} />
      </div>

      {loading ? (
        <Card><Loading rows={4} /></Card>
      ) : items.length ? (
        <div className="grid two">
          {COLUMNS.map((column) => {
            const cards = items.filter((task) => task.status === column.status);
            return (
              <Card key={column.status} title={`${column.label} (${cards.length})`}>
                {cards.length ? (
                  <div className="stack">
                    {cards.map((task) => (
                      <div key={task.id} className="panel" style={{ padding: 12 }}>
                        <div className="row" style={{ gap: 8, alignItems: 'flex-start' }}>
                          <div style={{ minWidth: 0 }}>
                            <strong style={{ fontSize: '0.8125rem' }}>{task.title}</strong>
                            <div className="tiny dim" style={{ marginTop: 2 }}>
                              {task.kind} · {task.assignee || 'unassigned'}
                              {task.site ? ` · ${task.site}` : ''}
                            </div>
                          </div>
                          <Badge tone={PRIORITY_TONE[task.priority]}>{task.priority}</Badge>
                        </div>
                        {task.note ? <p className="tiny muted" style={{ marginTop: 6 }}>{task.note}</p> : null}
                        <div className="row wrap" style={{ gap: 6, marginTop: 8 }}>
                          <Button size="sm" variant="ghost" loading={busy === task.id} onClick={() => advance(task)}>
                            {NEXT_LABEL[task.status]}
                          </Button>
                          <Button
                            size="sm"
                            variant="danger"
                            icon="trash"
                            loading={busy === task.id}
                            onClick={() => remove(task)}
                            aria-label={`Delete ${task.title}`}
                          />
                          <span className={`tiny right ${overdue(task) ? '' : 'dim'}`} style={overdue(task) ? { color: 'var(--danger)' } : undefined}>
                            {task.dueAt ? `due ${relativeTime(task.dueAt)}` : 'no due date'}
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="tiny dim">Nothing here.</p>
                )}
              </Card>
            );
          })}
        </div>
      ) : (
        <Card>
          <Empty icon="terminal" title="No tasks" action={<Button variant="primary" onClick={() => setOpen(true)}>Create one</Button>}>
            Tasks carry kind, priority, an owner and an optional site.
          </Empty>
        </Card>
      )}

      {open ? (
        <Modal
          title="New task"
          onClose={() => setOpen(false)}
          footer={
            <>
              <Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
              <Button variant="primary" loading={busy === 'new'} disabled={form.title.trim().length < 3} onClick={create}>
                Create task
              </Button>
            </>
          }
        >
          <div className="stack">
            <Input label="Title" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="Replace failed SBC at Rotterdam DC" />
            <div className="grid two">
              <Select label="Kind" value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })}>
                <option value="maintenance">Maintenance</option>
                <option value="incident">Incident</option>
                <option value="change">Change</option>
                <option value="provisioning">Provisioning</option>
                <option value="audit">Audit</option>
              </Select>
              <Select label="Priority" value={form.priority} onChange={(e) => setForm({ ...form, priority: e.target.value })}>
                <option value="low">Low</option>
                <option value="normal">Normal</option>
                <option value="high">High</option>
                <option value="critical">Critical</option>
              </Select>
            </div>
            <div className="grid two">
              <Input label="Assignee" value={form.assignee} onChange={(e) => setForm({ ...form, assignee: e.target.value })} />
              <Input label="Due" type="date" value={form.dueAt} onChange={(e) => setForm({ ...form, dueAt: e.target.value })} />
            </div>
            <Input label="Note" value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} />
          </div>
        </Modal>
      ) : null}
    </>
  );
}
