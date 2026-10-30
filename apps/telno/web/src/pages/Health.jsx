import { useEffect, useState } from 'react';
import { api, relativeTime } from '../api.js';
import { Badge, Button, Card, Empty, Loading, PageHeader, Stat, useToast } from '../ui.jsx';

const TONE = { up: 'success', degraded: 'warning', down: 'danger' };

const phrase = (seconds) => {
  const total = Math.max(0, Math.round(seconds || 0));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  if (hours) return `${hours}h ${minutes}m`;
  if (minutes) return `${minutes}m ${total % 60}s`;
  return `${total}s`;
};

export default function Health() {
  const toast = useToast();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);

  const load = async () => {
    try {
      setData(await api.get('/health/summary'));
    } catch (err) {
      toast.error('Could not read platform health', err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    const timer = setInterval(load, 30000);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const runChecks = async () => {
    setRunning(true);
    try {
      const fresh = await api.post('/health/checks/run', {});
      setData(fresh);
      toast.success('Checks complete', `${fresh.counts.up} up, ${fresh.counts.degraded} degraded, ${fresh.counts.down} down.`);
    } catch (err) {
      toast.error('Could not run the checks', err.message);
    } finally {
      setRunning(false);
    }
  };

  const counts = data?.counts || { up: 0, degraded: 0, down: 0 };
  const overall = data?.status || 'up';

  return (
    <>
      <PageHeader
        title="Health"
        subtitle="Probes this container can observe — database, API, switch, delivery and directory hosts"
        actions={<Button variant="primary" icon="refresh" loading={running} onClick={runChecks}>Run checks</Button>}
      />

      <div className="grid stats">
        <Stat label="Overall" value={overall.toUpperCase()} foot="Worst current probe" tone={overall === 'up' ? 'var(--success)' : overall === 'degraded' ? 'var(--warning)' : 'var(--danger)'} />
        <Stat label="Up" value={counts.up} foot="Passing" />
        <Stat label="Degraded" value={counts.degraded} foot="Working with a caveat" tone={counts.degraded ? 'var(--warning)' : undefined} />
        <Stat label="Down" value={counts.down} foot="Failing" tone={counts.down ? 'var(--danger)' : undefined} />
      </div>

      <div className="grid three">
        <Card title="Runtime">
          <div className="kv"><span>Uptime</span><strong className="mono">{phrase(data?.runtime?.uptime)}</strong></div>
          <div className="kv"><span>Memory</span><strong className="mono">{data?.runtime?.memoryMb ?? '—'} MB</strong></div>
          <div className="kv"><span>Node</span><strong className="mono">{data?.runtime?.node || '—'}</strong></div>
          <div className="kv"><span>DB latency</span><strong className="mono">{data?.runtime?.dbLatencyMs ?? '—'} ms</strong></div>
        </Card>
        <Card title="Switch">
          <div className="kv">
            <span>State</span>
            <strong>
              <Badge tone={data?.telephony?.connected ? 'success' : data?.telephony?.simulated ? 'warning' : 'danger'}>
                {data?.telephony?.connected ? 'connected' : data?.telephony?.simulated ? 'simulated' : 'offline'}
              </Badge>
            </strong>
          </div>
          <div className="kv"><span>Transport</span><strong className="mono">{data?.telephony?.transport || 'CANTUS'}</strong></div>
          <div className="kv"><span>Host</span><strong className="mono">{data?.telephony?.host || '—'}</strong></div>
          {data?.telephony?.error ? (
            <div className="kv">
              <span>Why</span>
              <strong className="mono tiny">{data.telephony.error}</strong>
            </div>
          ) : null}
          <div className="kv"><span>Version</span><strong className="mono">{data?.telephony?.version || '—'}</strong></div>
        </Card>
        <Card title="Delivery">
          <div className="kv"><span>Channel</span><strong className="mono">{data?.channels?.active || '—'}</strong></div>
          <div className="kv"><span>Available</span><strong className="mono">{data?.channels?.available?.join(', ') || '—'}</strong></div>
          <div className="kv"><span>Dev codes</span><strong className="mono">{data?.channels?.devExposeCodes ? 'exposed' : 'hidden'}</strong></div>
        </Card>
      </div>

      <Card title="Latest probe per target" subtitle="Append-only history; the newest row for a target is current" bodyClass="tight">
        {loading ? (
          <div style={{ padding: 16 }}><Loading rows={4} /></div>
        ) : data?.checks?.length ? (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Target</th>
                  <th>Kind</th>
                  <th>Status</th>
                  <th className="align-right">Latency</th>
                  <th>Detail</th>
                  <th>Checked</th>
                </tr>
              </thead>
              <tbody>
                {data.checks.map((check) => (
                  <tr key={check.id}>
                    <td className="tiny mono">{check.target}</td>
                    <td className="tiny dim">{check.kind}</td>
                    <td><Badge tone={TONE[check.status] || 'neutral'} dot={check.status === 'up' ? 'live' : check.status === 'down' ? 'down' : 'warn'}>{check.status}</Badge></td>
                    <td className="align-right tiny mono">{check.latencyMs} ms</td>
                    <td className="tiny dim">{check.detail}</td>
                    <td className="tiny dim nowrap">{relativeTime(check.checkedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty icon="pulse" title="No probes recorded" action={<Button variant="primary" onClick={runChecks}>Run the first check</Button>}>
            Running the checks writes one row per target; nothing is probed on a schedule by this screen.
          </Empty>
        )}
      </Card>
    </>
  );
}
