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
  Tabs,
  useToast,
} from '../ui.jsx';

const TONE = { active: 'success', degraded: 'warning', offline: 'danger', planned: 'neutral' };
const KINDS = ['handset', 'gateway', 'ata', 'conference', 'door'];
const STATES = ['online', 'offline', 'provisioning', 'faulty'];

const BLANK_SITE = { name: '', address: '', city: '', country: '', timezone: '', status: 'active' };
const BLANK_DEVICE = {
  name: '',
  siteId: '',
  kind: 'handset',
  model: '',
  mac: '',
  ip: '',
  extension: '',
  status: 'provisioning',
};

export default function Estate() {
  const toast = useToast();
  const [items, setItems] = useState([]);
  const [devices, setDevices] = useState([]);
  const [summary, setSummary] = useState(null);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState('');
  const [open, setOpen] = useState(false);
  const [deviceOpen, setDeviceOpen] = useState(false);
  const [tokenInfo, setTokenInfo] = useState(null);
  const [provision, setProvision] = useState(null);
  const [busy, setBusy] = useState('');
  const [form, setForm] = useState(BLANK_SITE);
  const [deviceForm, setDeviceForm] = useState(BLANK_DEVICE);

  const load = async () => {
    try {
      const [sites, inventory] = await Promise.all([
        api.get('/estate/sites'),
        api.get(`/estate/devices${tab ? `?kind=${tab}` : ''}`),
      ]);
      setItems(sites.items);
      setSummary(sites.summary);
      setDevices(inventory.items);
    } catch (err) {
      toast.error('Could not load the estate', err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  const patch = async (site, body) => {
    setBusy(site.id);
    try {
      const data = await api.patch(`/estate/sites/${site.id}`, body);
      setItems((list) => list.map((item) => (item.id === site.id ? data.site : item)));
      load();
    } catch (err) {
      toast.error('Could not update the site', err.message);
    } finally {
      setBusy('');
    }
  };

  const remove = async (site) => {
    if (
      !window.confirm(
        `Delete ${site.name}? Its ${site.deviceCount} device${site.deviceCount === 1 ? '' : 's'} go with it; tasks that referenced it keep their history.`
      )
    )
      return;
    setBusy(site.id);
    try {
      await api.del(`/estate/sites/${site.id}`);
      setItems((list) => list.filter((item) => item.id !== site.id));
      load();
      toast.success('Site deleted', 'Its devices were retired with it.');
    } catch (err) {
      toast.error('Could not delete the site', err.message);
    } finally {
      setBusy('');
    }
  };

  const create = async () => {
    setBusy('new');
    try {
      const data = await api.post('/estate/sites', form);
      setItems((list) => [...list, data.site]);
      load();
      setOpen(false);
      setForm(BLANK_SITE);
      toast.success('Site added', 'Add its handsets and gateways next.');
    } catch (err) {
      toast.error('Could not add the site', err.message);
    } finally {
      setBusy('');
    }
  };

  const addDevice = async () => {
    setBusy('device');
    try {
      const data = await api.post('/estate/devices', {
        name: deviceForm.name,
        siteId: deviceForm.siteId,
        kind: deviceForm.kind,
        model: deviceForm.model,
        mac: deviceForm.mac,
        ip: deviceForm.ip,
        extension: deviceForm.extension,
        status: deviceForm.status,
      });
      setDevices((list) => [...list, data.device]);
      load();
      setDeviceOpen(false);
      setDeviceForm(BLANK_DEVICE);
      // The check-in token is only ever visible here, so show it once, plainly.
      if (data.token) setTokenInfo({ device: data.device, token: data.token, checkInSec: data.checkInSec });
      else toast.success('Device added', `${data.device.name} is ${data.device.status}.`);
    } catch (err) {
      toast.error('Could not add the device', err.message);
    } finally {
      setBusy('');
    }
  };

  const patchDevice = async (device, body) => {
    setBusy(device.id);
    try {
      const data = await api.patch(`/estate/devices/${device.id}`, body);
      setDevices((list) => list.map((item) => (item.id === device.id ? data.device : item)));
      load();
    } catch (err) {
      toast.error('Could not update the device', err.message);
    } finally {
      setBusy('');
    }
  };

  const rotateToken = async (device) => {
    setBusy(device.id);
    try {
      const data = await api.post(`/estate/devices/${device.id}/token`, {});
      setDevices((list) => list.map((item) => (item.id === device.id ? data.device : item)));
      setTokenInfo({ device: data.device, token: data.token, checkInSec: data.checkInSec });
    } catch (err) {
      toast.error('Could not issue a token', err.message);
    } finally {
      setBusy('');
    }
  };

  const provisionDevice = async (device, format = 'yealink') => {
    setBusy(device.id);
    try {
      const data = await api.get(`/estate/devices/${device.id}/provisioning?format=${format}`);
      setProvision({ ...data, deviceName: device.name });
      setDevices((list) => list.map((item) => (item.id === device.id ? { ...item, hasToken: true } : item)));
    } catch (err) {
      toast.error('Could not build the config', err.message);
    } finally {
      setBusy('');
    }
  };

  const removeDevice = async (device) => {
    if (!window.confirm(`Remove ${device.name} from ${device.site || 'the estate'}?`)) return;
    setBusy(device.id);
    try {
      await api.del(`/estate/devices/${device.id}`);
      setDevices((list) => list.filter((item) => item.id !== device.id));
      load();
      toast.success('Device removed');
    } catch (err) {
      toast.error('Could not remove the device', err.message);
    } finally {
      setBusy('');
    }
  };

  return (
    <>
      <PageHeader
        title="Estate"
        subtitle="Every physical site and the handsets, gateways and door phones installed there"
        actions={<Button variant="primary" icon="plus" onClick={() => setOpen(true)}>Add site</Button>}
      />

      <div className="grid stats">
        <Stat label="Sites" value={summary?.sites ?? '—'} foot="Across all regions" />
        <Stat label="Devices" value={summary?.devices ?? '—'} foot="Real inventory rows" />
        <Stat label="Online" value={summary?.online ?? '—'} foot="Reporting in" />
        <Stat
          label="Attention"
          value={(summary?.problemDevices ?? 0) + (summary?.silentDevices ?? 0)}
          foot="Offline, faulty or silent"
          tone={(summary?.problemDevices ?? 0) + (summary?.silentDevices ?? 0) ? 'var(--danger)' : undefined}
        />
      </div>

      {loading ? (
        <Card><Loading rows={4} /></Card>
      ) : items.length ? (
        <div className="grid three">
          {items.map((site) => {
            const silent = devices.filter((device) => device.siteId === site.id && device.silent).length;
            return (
            <Card
              key={site.id}
              title={site.name}
              subtitle={[site.city, site.country].filter(Boolean).join(', ') || 'No address'}
              actions={<Badge tone={TONE[site.status]} dot={site.status === 'active' ? 'live' : site.status === 'offline' ? 'down' : site.status === 'degraded' ? 'warn' : undefined}>{site.status}</Badge>}
            >
              <div className="stack">
                <div className="row wrap" style={{ gap: 12 }}>
                  <span className="tiny dim">
                    {site.deviceCount} device{site.deviceCount === 1 ? '' : 's'}
                  </span>
                  <span className="tiny dim">·</span>
                  <span className="tiny dim">{site.onlineCount} online</span>
                  {site.problemCount ? (
                    <>
                      <span className="tiny dim">·</span>
                      <span className="tiny" style={{ color: 'var(--danger)' }}>{site.problemCount} down</span>
                    </>
                  ) : null}
                  {silent ? (
                    <>
                      <span className="tiny dim">·</span>
                      <span className="tiny" style={{ color: 'var(--warning)' }}>{silent} silent</span>
                    </>
                  ) : null}
                  <span className="tiny dim">·</span>
                  <span className="tiny mono">{site.latencyMs} ms</span>
                </div>
                <p className="tiny dim">{site.address || 'No street address recorded.'}</p>
                <div className="row wrap" style={{ gap: 6 }}>
                  <Select
                    value={site.status}
                    onChange={(e) => patch(site, { status: e.target.value })}
                    disabled={busy === site.id}
                    aria-label={`Status for ${site.name}`}
                    style={{ width: 130 }}
                  >
                    <option value="active">active</option>
                    <option value="degraded">degraded</option>
                    <option value="offline">offline</option>
                    <option value="planned">planned</option>
                  </Select>
                  <Button
                    size="sm"
                    icon="plus"
                    onClick={() => {
                      setDeviceForm({ ...BLANK_DEVICE, siteId: site.id });
                      setDeviceOpen(true);
                    }}
                  >
                    Device
                  </Button>
                  <Button
                    size="sm"
                    variant="danger"
                    icon="trash"
                    loading={busy === site.id}
                    onClick={() => remove(site)}
                    aria-label={`Delete ${site.name}`}
                  />
                  <span className="tiny dim right">seen {relativeTime(site.lastSeenAt)}</span>
                </div>
              </div>
            </Card>
            );
          })}
        </div>
      ) : (
        <Card>
          <Empty icon="building" title="No sites yet" action={<Button variant="primary" onClick={() => setOpen(true)}>Add the first one</Button>}>
            Sites group real equipment by location so health and tasks can be scoped to them.
          </Empty>
        </Card>
      )}

      <Card
        title="Devices"
        subtitle="Handsets, gateways, ATAs and door phones — one row per box on a wall"
        bodyClass="tight"
        actions={
          <div className="row" style={{ gap: 10 }}>
            <Tabs
              value={tab}
              onChange={setTab}
              tabs={[{ value: '', label: 'All' }, ...KINDS.map((kind) => ({ value: kind, label: kind }))]}
            />
            <Button size="sm" icon="plus" onClick={() => { setDeviceForm(BLANK_DEVICE); setDeviceOpen(true); }}>
              Add device
            </Button>
          </div>
        }
      >
        {loading ? (
          <div style={{ padding: 16 }}><Loading rows={4} /></div>
        ) : devices.length ? (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Device</th>
                  <th>Site</th>
                  <th>Kind</th>
                  <th>Extension</th>
                  <th>MAC</th>
                  <th>Address</th>
                  <th>Last seen</th>
                  <th>Status</th>
                  <th className="align-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {devices.map((device) => (
                  <tr key={device.id}>
                    <td>
                      <div className="stack" style={{ gap: 0 }}>
                        <span className="tiny">{device.name}</span>
                        <span className="tiny dim">{device.model || 'Unmodeled'}</span>
                      </div>
                    </td>
                    <td className="tiny">{device.site || 'Unassigned'}</td>
                    <td><Badge tone="neutral">{device.kind}</Badge></td>
                    <td className="tiny mono">{device.extension || '—'}</td>
                    <td className="tiny mono dim">{device.mac || '—'}</td>
                    <td className="tiny mono dim">{device.ip || '—'}</td>
                    <td className="tiny dim nowrap">
                      {relativeTime(device.lastSeenAt)}
                      {device.silent ? (
                        <>
                          {' '}
                          <Badge tone="warning">silent</Badge>
                        </>
                      ) : null}
                    </td>
                    <td>
                      <Select
                        value={device.status}
                        onChange={(e) => patchDevice(device, { status: e.target.value })}
                        disabled={busy === device.id}
                        aria-label={`Status for ${device.name}`}
                        style={{ width: 128 }}
                      >
                        {STATES.map((state) => (
                          <option key={state} value={state}>{state}</option>
                        ))}
                      </Select>
                    </td>
                    <td className="align-right">
                      <Button
                        size="sm"
                        variant="ghost"
                        icon="download"
                        loading={busy === device.id}
                        onClick={() => provisionDevice(device)}
                        title="Generate a provisioning config"
                        aria-label={`Provisioning config for ${device.name}`}
                      />
                      <Button
                        size="sm"
                        variant="ghost"
                        icon="key"
                        loading={busy === device.id}
                        onClick={() => rotateToken(device)}
                        title="Issue a new check-in token"
                        aria-label={`New token for ${device.name}`}
                      />
                      <Button
                        size="sm"
                        variant="ghost"
                        icon="trash"
                        loading={busy === device.id}
                        onClick={() => removeDevice(device)}
                        aria-label={`Remove ${device.name}`}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty
            icon="server"
            title="No devices in the inventory"
            action={<Button variant="primary" onClick={() => setDeviceOpen(true)}>Add the first device</Button>}
          >
            A device only exists once it is recorded here — counts are derived from these rows.
          </Empty>
        )}
      </Card>

      {open ? (
        <Modal
          title="Add site"
          onClose={() => setOpen(false)}
          footer={
            <>
              <Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
              <Button variant="primary" loading={busy === 'new'} disabled={!form.name.trim()} onClick={create}>
                Add site
              </Button>
            </>
          }
        >
          <div className="stack">
            <Input label="Name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Rotterdam DC" />
            <Input label="Address" value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} />
            <div className="grid two">
              <Input label="City" value={form.city} onChange={(e) => setForm({ ...form, city: e.target.value })} />
              <Input label="Country" maxLength={2} value={form.country} onChange={(e) => setForm({ ...form, country: e.target.value.toUpperCase() })} placeholder="NL" />
            </div>
            <div className="grid two">
              <Input label="Timezone" value={form.timezone} onChange={(e) => setForm({ ...form, timezone: e.target.value })} placeholder="Europe/Amsterdam" />
              <Select label="Status" value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })}>
                <option value="active">active</option>
                <option value="degraded">degraded</option>
                <option value="offline">offline</option>
                <option value="planned">planned</option>
              </Select>
            </div>
          </div>
        </Modal>
      ) : null}

      {deviceOpen ? (
        <Modal
          title="Add device"
          subtitle="One row per handset, gateway or door phone"
          onClose={() => setDeviceOpen(false)}
          footer={
            <>
              <Button variant="ghost" onClick={() => setDeviceOpen(false)}>Cancel</Button>
              <Button
                variant="primary"
                loading={busy === 'device'}
                disabled={!deviceForm.name.trim() || !deviceForm.siteId}
                onClick={addDevice}
              >
                Add device
              </Button>
            </>
          }
        >
          <div className="stack">
            <div className="grid two">
              <Input label="Name" value={deviceForm.name} onChange={(e) => setDeviceForm({ ...deviceForm, name: e.target.value })} placeholder="Reception desk" />
              <Select label="Site" value={deviceForm.siteId} onChange={(e) => setDeviceForm({ ...deviceForm, siteId: e.target.value })}>
                <option value="">Choose a site…</option>
                {items.map((site) => (
                  <option key={site.id} value={site.id}>{site.name}</option>
                ))}
              </Select>
            </div>
            <div className="grid two">
              <Select label="Kind" value={deviceForm.kind} onChange={(e) => setDeviceForm({ ...deviceForm, kind: e.target.value })}>
                {KINDS.map((kind) => (
                  <option key={kind} value={kind}>{kind}</option>
                ))}
              </Select>
              <Input label="Model" value={deviceForm.model} onChange={(e) => setDeviceForm({ ...deviceForm, model: e.target.value })} placeholder="Yealink T54W" />
            </div>
            <div className="grid two">
              <Input
                label="MAC"
                value={deviceForm.mac}
                onChange={(e) => setDeviceForm({ ...deviceForm, mac: e.target.value })}
                placeholder="80:5E:C0:11:24:01"
                hint="Unique across the estate."
              />
              <Input label="IP" value={deviceForm.ip} onChange={(e) => setDeviceForm({ ...deviceForm, ip: e.target.value })} placeholder="10.10.1.21" />
            </div>
            <div className="grid two">
              <Input
                label="Extension"
                value={deviceForm.extension}
                onChange={(e) => setDeviceForm({ ...deviceForm, extension: e.target.value })}
                placeholder="101"
                hint="Optional; leave blank for infrastructure."
              />
              <Select label="Status" value={deviceForm.status} onChange={(e) => setDeviceForm({ ...deviceForm, status: e.target.value })}>
                {STATES.map((state) => (
                  <option key={state} value={state}>{state}</option>
                ))}
              </Select>
            </div>
            <p className="tiny dim">
              The device gets a check-in token when it is created — that is what lets it report itself
              without anyone editing the row.
            </p>
          </div>
        </Modal>
      ) : null}

      {provision ? (
        <Modal
          title={`Provision ${provision.deviceName}`}
          subtitle="Booting from this file also rotates the check-in token"
          onClose={() => setProvision(null)}
          wide
          footer={
            <>
              <Button variant="ghost" onClick={() => setProvision(null)}>Close</Button>
              <Button
                icon="copy"
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(provision.config);
                    toast.success('Config copied');
                  } catch {
                    toast.error('Could not copy', 'Select the text and copy it manually.');
                  }
                }}
              >
                Copy
              </Button>
              <Button
                variant="primary"
                icon="download"
                onClick={() => {
                  const blob = new Blob([provision.config], { type: provision.contentType });
                  const url = URL.createObjectURL(blob);
                  const link = document.createElement('a');
                  link.href = url;
                  link.download = provision.fileName;
                  link.click();
                  URL.revokeObjectURL(url);
                }}
              >
                Download
              </Button>
            </>
          }
        >
          <div className="stack">
            <Select
              label="Format"
              value={provision.format}
              onChange={(e) => provisionDevice({ id: provision.deviceId, name: provision.deviceName }, e.target.value)}
            >
              <option value="yealink">Yealink .cfg</option>
              <option value="grandstream">Grandstream .xml</option>
            </Select>
            <pre
              className="mono tiny"
              style={{
                margin: 0,
                padding: 12,
                maxHeight: 360,
                overflow: 'auto',
                borderRadius: 'var(--radius)',
                background: 'var(--surface-2)',
                border: '1px solid var(--border-strong)',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-all',
              }}
            >
              {provision.config}
            </pre>
          </div>
        </Modal>
      ) : null}

      {tokenInfo ? (
        <Modal
          title="Device token"
          subtitle="Shown once — copy it into the device's configuration"
          onClose={() => setTokenInfo(null)}
          footer={<Button variant="primary" onClick={() => setTokenInfo(null)}>Done</Button>}
        >
          <div className="stack">
            <p className="tiny dim">
              {tokenInfo.device.name}
              {tokenInfo.device.site ? ` · ${tokenInfo.device.site}` : ''} checks in with this token. Only its
              hash is stored, so it cannot be shown again — issue a new one if it is lost.
            </p>
            <pre
              className="mono tiny"
              style={{
                margin: 0,
                padding: 12,
                borderRadius: 'var(--radius)',
                background: 'var(--surface-2)',
                border: '1px solid var(--border-strong)',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-all',
              }}
            >
              {tokenInfo.token}
            </pre>
            <div className="row" style={{ gap: 8 }}>
              <Button
                size="sm"
                icon="copy"
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(tokenInfo.token);
                    toast.success('Token copied');
                  } catch {
                    toast.error('Could not copy', 'Select the token and copy it manually.');
                  }
                }}
              >
                Copy token
              </Button>
              <span className="tiny dim">
                Check in every {Math.round((tokenInfo.checkInSec || 300) / 60)} min.
              </span>
            </div>
            <pre
              className="mono tiny"
              style={{
                margin: 0,
                padding: 12,
                borderRadius: 'var(--radius)',
                background: 'var(--surface-2)',
                border: '1px solid var(--border-strong)',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-all',
              }}
            >{`curl -X POST ${window.location.origin}/api/devices/heartbeat \\
  -H "x-device-token: ${tokenInfo.token}" \\
  -H "content-type: application/json" \\
  -d '{"status":"online"}'`}</pre>
          </div>
        </Modal>
      ) : null}
    </>
  );
}
