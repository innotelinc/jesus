import { useEffect, useMemo, useState } from 'react';
import { api, relativeTime } from '../api.js';
import { Badge, Button, Card, Empty, Icon, Input, Loading, Modal, PageHeader, Stat, useToast } from '../ui.jsx';

const STATE_TONE = { up: 'success', auth: 'warning', down: 'danger' };
const STATE_LABEL = { up: 'Reachable', auth: 'SSO sign-in', down: 'Unreachable' };
const STATE_DOT = { up: 'live', auth: 'warn', down: 'down' };

/**
 * Redirect targets can be relative (`/auth/login`), so never derive a host by
 * resolving them — relative means "the same host as that system".
 */
const redirectLabel = (value) => {
  if (!value) return '';
  if (value.startsWith('/')) return 'same host';
  try {
    return new URL(value).host;
  } catch {
    return value.slice(0, 40);
  }
};

export default function Systems() {
  const toast = useToast();
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState('');
  const [query, setQuery] = useState('');
  const [form, setForm] = useState({ name: '', url: '', description: '' });

  const load = async ({ refresh = false } = {}) => {
    if (refresh) setRefreshing(true);
    try {
      const data = await api.get(`/systems${refresh ? '?refresh=1' : ''}`);
      setItems(data.items);
    } catch (err) {
      toast.error('Could not load connected systems', err.message);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const create = async () => {
    setBusy('new');
    try {
      const data = await api.post('/systems', {
        name: form.name,
        url: form.url,
        description: form.description,
      });
      setItems((list) => [...list, data.system]);
      setOpen(false);
      setForm({ name: '', url: '', description: '' });
      load({ refresh: true });
      toast.success('System registered', `${data.system.name} is now in the front door.`);
    } catch (err) {
      toast.error('Could not register the system', err.message);
    } finally {
      setBusy('');
    }
  };

  const remove = async (system) => {
    if (!window.confirm(`Remove ${system.name} from the front door? Nothing is deleted at ${system.host}.`)) return;
    setBusy(system.id);
    try {
      await api.del(`/systems/${system.id}`);
      setItems((list) => list.filter((item) => item.id !== system.id));
      toast.success('System removed', `${system.name} is no longer listed.`);
    } catch (err) {
      toast.error('Could not remove the system', err.message);
    } finally {
      setBusy('');
    }
  };

  const toggle = async (system) => {
    setBusy(system.id);
    try {
      const data = await api.patch(`/systems/${system.id}`, { enabled: !system.enabled });
      setItems((list) => list.map((item) => (item.id === system.id ? { ...item, ...data.system } : item)));
      load({ refresh: true });
    } catch (err) {
      toast.error('Could not change the system', err.message);
    } finally {
      setBusy('');
    }
  };

  // Derived, not stored: adding, disabling or removing a row must never leave a
  // tile disagreeing with the list underneath it.
  const summary = useMemo(
    () => ({
      total: items.length,
      up: items.filter((item) => item.probe?.state === 'up').length,
      auth: items.filter((item) => item.probe?.state === 'auth').length,
      down: items.filter((item) => item.probe?.state === 'down').length,
    }),
    [items]
  );

  const needle = query.trim().toLowerCase();
  // Filtering happens on modules too, so 27 dashboard destinations are one query away.
  const visible = needle
    ? items
        .map((item) => ({
          ...item,
          links: item.links.filter((link) =>
            `${link.label} ${link.path}`.toLowerCase().includes(needle)
          ),
        }))
        .filter(
          (item) =>
            item.links.length ||
            `${item.name} ${item.description} ${item.host}`.toLowerCase().includes(needle)
        )
    : items;

  const groups = visible.reduce((acc, item) => {
    const key = item.group || 'Connected';
    (acc[key] = acc[key] || []).push(item);
    return acc;
  }, {});

  const moduleCount = items.reduce((sum, item) => sum + item.links.length, 0);

  return (
    <>
      <PageHeader
        title="Connected systems"
        subtitle="One front door for the consoles that keep their own admin surface"
        actions={
          <div className="row" style={{ gap: 8 }}>
            <Button icon="refresh" loading={refreshing} onClick={() => load({ refresh: true })}>
              Check now
            </Button>
            <Button variant="primary" icon="plus" onClick={() => setOpen(true)}>
              Add system
            </Button>
          </div>
        }
      />

      <div className="grid stats">
        <Stat label="Systems" value={loading ? '—' : summary.total} foot="Registered front doors" />
        <Stat label="Reachable" value={loading ? '—' : summary.up} foot="Answering directly" />
        <Stat
          label="Behind SSO"
          value={loading ? '—' : summary.auth}
          foot="Authentik gateway"
          tone={summary.auth ? 'var(--warning)' : undefined}
        />
        <Stat
          label="Down"
          value={loading ? '—' : summary.down}
          foot="Unreachable or erroring"
          tone={summary.down ? 'var(--danger)' : undefined}
        />
      </div>

      <div className="row wrap" style={{ gap: 10 }}>
        <div style={{ position: 'relative', flex: '1 1 260px', minWidth: 220 }}>
          <Icon
            name="search"
            size={14}
            style={{ position: 'absolute', left: 11, top: '50%', transform: 'translateY(-50%)', opacity: 0.5 }}
          />
          <input
            className="input"
            style={{ paddingLeft: 32 }}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={`Search ${items.length} systems and ${moduleCount} modules`}
            aria-label="Search connected systems and modules"
          />
        </div>
        {query ? (
          <span className="tiny dim">
            {visible.length} of {items.length} systems match
          </span>
        ) : null}
      </div>

      {loading ? (
        <Card><Loading rows={4} /></Card>
      ) : visible.length ? (
        <div className="stack">
          {Object.entries(groups).map(([group, list]) => (
            <Card key={group} title={group} subtitle={`${list.length} system${list.length === 1 ? '' : 's'}`}>
              <div className="stack">
                {list.map((system) => (
                  <div key={system.id} className="panel" style={{ padding: 14 }}>
                    <div className="row wrap" style={{ gap: 10, justifyContent: 'space-between' }}>
                      <div className="stack" style={{ gap: 2, minWidth: 0 }}>
                        <div className="row" style={{ gap: 8 }}>
                          <Badge tone={STATE_TONE[system.probe?.state] || 'neutral'} dot={STATE_DOT[system.probe?.state]}>
                            {system.enabled ? STATE_LABEL[system.probe?.state] || 'Not checked' : 'Disabled'}
                          </Badge>
                          <strong>{system.name}</strong>
                        </div>
                        <span className="tiny dim">{system.description}</span>
                        <span className="tiny mono dim">
                          {system.url}
                          {system.probe?.latencyMs ? ` · ${system.probe.latencyMs} ms` : ''}
                          {system.probe?.statusCode ? ` · HTTP ${system.probe.statusCode}` : ''}
                          {system.probe?.redirectedTo ? ` · → ${redirectLabel(system.probe.redirectedTo)}` : ''}
                        </span>
                      </div>
                      <div className="row" style={{ gap: 6 }}>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => toggle(system)}
                          loading={busy === system.id}
                          aria-label={`${system.enabled ? 'Disable' : 'Enable'} ${system.name}`}
                        >
                          {system.enabled ? 'Disable' : 'Enable'}
                        </Button>
                        <Button
                          size="sm"
                          icon="external"
                          onClick={() => window.open(system.url, '_blank', 'noopener')}
                        >
                          Open
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          icon="trash"
                          aria-label={`Remove ${system.name}`}
                          loading={busy === system.id}
                          onClick={() => remove(system)}
                        />
                      </div>
                    </div>

                    {system.links?.length ? (
                      <div className="row wrap" style={{ gap: 6, marginTop: 10 }}>
                        {system.links.map((link) => (
                          <a
                            key={`${system.id}-${link.path}`}
                            className="badge"
                            style={{ textDecoration: 'none' }}
                            href={`${system.host}${link.path}`}
                            target="_blank"
                            rel="noreferrer"
                          >
                            {link.label}
                          </a>
                        ))}
                      </div>
                    ) : null}
                  </div>
                ))}
              </div>
            </Card>
          ))}
          <p className="tiny dim">
            Probes run server-side every 60 seconds, do not follow redirects and never authenticate: a
            console that answers with a sign-in redirect is reported as <strong>SSO sign-in</strong>, which
            is health, not failure. Last check {relativeTime(items.find((item) => item.probe)?.probe?.checkedAt)}.
          </p>
        </div>
      ) : (
        <Card>
          <Empty
            icon="globe"
            title={items.length ? 'No match' : 'No systems registered'}
            action={
              items.length ? (
                <Button onClick={() => setQuery('')}>Clear search</Button>
              ) : (
                <Button variant="primary" onClick={() => setOpen(true)}>Add one</Button>
              )
            }
          >
            {items.length
              ? 'Nothing in the system catalog matches that query.'
              : 'Register the consoles you still need and their module catalog appears here.'}
          </Empty>
        </Card>
      )}

      {open ? (
        <Modal
          title="Add system"
          subtitle="A host and the landing path an operator should land on"
          onClose={() => setOpen(false)}
          footer={
            <>
              <Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
              <Button variant="primary" loading={busy === 'new'} disabled={!form.name.trim() || !form.url.trim()} onClick={create}>
                Register
              </Button>
            </>
          }
        >
          <div className="stack">
            <Input label="Name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Capstone Control Center" />
            <Input
              label="URL"
              value={form.url}
              onChange={(e) => setForm({ ...form, url: e.target.value })}
              placeholder="https://dashboard.pbx.it.com/interviews"
              hint="Full http(s) URL. Private and loopback addresses are refused."
            />
            <Input label="Description" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
          </div>
        </Modal>
      ) : null}
    </>
  );
}
