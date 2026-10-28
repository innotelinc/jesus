import { useEffect, useState } from 'react';
import { api, prettyNumber, compactNumber, duration, clockTime, relativeTime } from '../api.js';
import { Badge, Button, Card, Empty, Icon, Loading, PageHeader, Stat, statusTone, useToast } from '../ui.jsx';
import { Link } from '../router.jsx';

export default function Dashboard() {
  const toast = useToast();
  const [status, setStatus] = useState(null);
  const [stats, setStats] = useState(null);
  const [calls, setCalls] = useState([]);
  const [queue, setQueue] = useState(null);
  const [systems, setSystems] = useState([]);
  const [loading, setLoading] = useState(true);

  const load = async () => {
    try {
      const [statusData, statsData, callsData, queueData] = await Promise.all([
        api.get('/system/status'),
        api.get('/calls/stats'),
        api.get('/calls?limit=7'),
        api.get('/submissions?status=verified&limit=5'),
      ]);
      setStatus(statusData);
      setStats(statsData);
      setCalls(callsData.items);
      setQueue(queueData);
    } catch (err) {
      toast.error('Could not load the dashboard', err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    // Separate from the main load: probes can take seconds and must not hold
    // up the numbers an operator actually opened this page for.
    api
      .get('/systems')
      .then((data) => setSystems(data.items.filter((item) => item.enabled)))
      .catch(() => setSystems([]));
    const timer = setInterval(load, 20000);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (loading) {
    return <Loading rows={5} />;
  }

  const last24 = stats?.last24h || { total: 0, answered: 0, missed: 0, avgTalk: 0 };
  const answerRate = last24.total ? Math.round((last24.answered / last24.total) * 100) : 0;
  const telephony = status?.telephony || {};
  const directory = status?.directory || {};
  const daily = stats?.daily || [];
  const peak = Math.max(1, ...daily.map((d) => d.total));
  const pending = status?.counts?.pending || 0;

  return (
    <>
      <PageHeader
        title="Today"
        subtitle={
          directory.updatedAt
            ? `Registry last changed ${relativeTime(directory.updatedAt)}`
            : 'Registry is ready'
        }
        actions={
          // No Apply button: every change is written to the switch and reloaded
          // as it is saved, so there is nothing here to press.
          <Button variant="ghost" icon="refresh" onClick={load}>
            Refresh
          </Button>
        }
      />

      <div className="grid stats">
        <Stat
          label="Calls · 24h"
          value={compactNumber(last24.total)}
          foot={
            <>
              <Icon name="arrowUp" size={12} />
              {last24.answered} answered · {last24.missed} missed
            </>
          }
        />
        <Stat label="Answer rate" value={`${answerRate}%`} foot={`Avg talk ${duration(last24.avgTalk)}`} />
        <Stat
          label="Active numbers"
          value={compactNumber(directory.numbers)}
          foot={`${directory.countries} countries · ${compactNumber(directory.listings)} listings`}
        />
        <Stat
          label="Awaiting review"
          value={compactNumber(pending)}
          foot={pending ? 'Listings verified by their owner' : 'Queue is clear'}
          tone={pending ? 'var(--warning)' : undefined}
        />
      </div>

      <div className="hero">
        <Card
          title="Call volume"
          subtitle="Last 7 days, all directions"
          actions={<Badge tone="accent">{compactNumber(daily.reduce((sum, d) => sum + d.total, 0))} calls</Badge>}
        >
          {daily.length ? (
            <>
              <div className="bars" role="img" aria-label="Call volume for the last seven days">
                {daily.map((day) => (
                  <div
                    key={day.day}
                    className="bar"
                    data-empty={day.total === 0 ? 'true' : 'false'}
                    data-label={`${day.day}: ${day.total} calls, ${day.answered} answered`}
                    style={{ height: `${Math.max(4, (day.total / peak) * 100)}%` }}
                  />
                ))}
              </div>
              <div className="legend" style={{ marginTop: 10, justifyContent: 'space-between' }}>
                <span>{daily[0]?.day}</span>
                <span>
                  <i style={{ background: 'var(--accent)' }} /> total
                  <i style={{ background: 'var(--success)', marginLeft: 10 }} /> {daily.reduce((s, d) => s + d.answered, 0)} answered
                </span>
                <span>{daily[daily.length - 1]?.day}</span>
              </div>
            </>
          ) : (
            <Empty icon="calls" title="No calls yet">
              Call history appears here once the switch reports CDR events.
            </Empty>
          )}
        </Card>

        <Card
          title="Telephony"
          actions={
            <Badge
              tone={telephony.connected ? 'success' : telephony.simulated ? 'warning' : 'danger'}
              dot={telephony.connected ? 'live' : telephony.simulated ? 'warn' : 'down'}
            >
              {telephony.connected ? 'Connected' : telephony.simulated ? 'Simulated' : 'Offline'}
            </Badge>
          }
        >
          <dl className="kv">
            <dt>Transport</dt>
            <dd className="mono">{telephony.transport || 'AMI'} · {telephony.host || '127.0.0.1'}:{telephony.port || 5038}</dd>
            <dt>Uptime</dt>
            <dd>{telephony.uptime || (telephony.simulated ? '—' : 'unknown')}</dd>
            <dt>Live channels</dt>
            <dd>{telephony.activeChannels?.length || 0}</dd>
            <dt>Extensions</dt>
            <dd>{status?.counts?.extensions || 0} configured</dd>
            <dt>Trunks</dt>
            <dd>{status?.counts?.trunks || 0} registered</dd>
          </dl>

          <div className="stack" style={{ marginTop: 14, gap: 8 }}>
            {(telephony.activeChannels || []).slice(0, 3).map((channel, index) => (
              <div className="live-call" key={index}>
                <span className="dot live" />
                <span className="mono tiny">{prettyNumber(channel.from) || channel.from}</span>
                <Icon name="chevron" size={12} className="dim" />
                <span className="mono tiny">{prettyNumber(channel.to) || channel.to}</span>
                <span className="right tiny dim">{duration(channel.seconds)}</span>
              </div>
            ))}
            {!telephony.activeChannels?.length ? (
              <p className="tiny dim">
                {telephony.simulated
                  ? 'No switch attached. Set AMI_HOST and AMI_SECRET to go live.'
                  : 'No active calls right now.'}
              </p>
            ) : null}
          </div>

          {telephony.error ? (
            <p className="tiny" style={{ color: 'var(--danger)', marginTop: 10 }}>
              {telephony.error}
            </p>
          ) : null}
        </Card>
      </div>

      {systems.length ? (
        <Card
          title="Connected systems"
          subtitle="The consoles this platform fronts, and whether they are answering"
          actions={
            <Link className="btn ghost sm" to="/systems">
              Manage
            </Link>
          }
        >
          <div className="row wrap" style={{ gap: 8 }}>
            {systems.map((system) => (
              <a
                key={system.id}
                className="badge"
                style={{ textDecoration: 'none', gap: 6 }}
                href={system.url}
                target="_blank"
                rel="noreferrer"
                title={`${system.url}${system.probe?.latencyMs ? ` · ${system.probe.latencyMs} ms` : ''}`}
              >
                {system.probe ? (
                  <span
                    className={`dot ${
                      system.probe.state === 'up' ? 'live' : system.probe.state === 'auth' ? 'warn' : 'down'
                    }`}
                  />
                ) : null}
                {system.name}
                <Icon name="external" size={11} />
              </a>
            ))}
          </div>
        </Card>
      ) : null}

      <div className="grid two">
        <Card
          title="Recent calls"
          bodyClass="tight"
          actions={<Link className="btn ghost sm" to="/calls">View all</Link>}
        >
          {calls.length ? (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Direction</th>
                    <th>From → To</th>
                    <th>Time</th>
                    <th className="align-right">Duration</th>
                    <th>Result</th>
                  </tr>
                </thead>
                <tbody>
                  {calls.map((call) => (
                    <tr key={call.id}>
                      <td>
                        <span className="row" style={{ gap: 5 }}>
                          <Icon name={call.direction === 'inbound' ? 'arrowDown' : call.direction === 'outbound' ? 'arrowUp' : 'branch'} size={13} />
                          <span className="tiny muted">{call.direction}</span>
                        </span>
                      </td>
                      <td className="num tiny truncate" style={{ maxWidth: 190 }}>
                        {call.from || '—'} → {call.to || '—'}
                      </td>
                      <td className="tiny dim nowrap">{clockTime(call.startedAt)}</td>
                      <td className="align-right tiny mono">{duration(call.billsec || call.duration)}</td>
                      <td>
                        <Badge tone={statusTone(call.disposition)}>{call.disposition}</Badge>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <Empty icon="calls" title="No call history yet" />
          )}
        </Card>

        <Card
          title="Review queue"
          actions={
            <Link className="btn ghost sm" to="/directory">
              Open
            </Link>
          }
        >
          {queue?.items?.length ? (
            <div className="stack">
              {queue.items.map((item) => (
                <div className="live-call" key={item.id} style={{ alignItems: 'flex-start' }}>
                  <div className="avatar">{item.name.slice(0, 2).toUpperCase()}</div>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div className="truncate" style={{ fontWeight: 550 }}>{item.name}</div>
                    <div className="tiny dim truncate">
                      {item.display || prettyNumber(item.e164)} · {item.city || item.country || 'unlocated'}
                    </div>
                  </div>
                  <Badge tone="info">verified</Badge>
                </div>
              ))}
            </div>
          ) : (
            <Empty icon="check" title="Nothing to review">
              Verified submissions land here before they go public.
            </Empty>
          )}
        </Card>
      </div>

      <div className="grid three">
        <Card title="Registry" subtitle="Canonical rows, de-duplicated">
          <dl className="kv">
            <dt>Numbers</dt>
            <dd className="mono">{compactNumber(directory.numbers)}</dd>
            <dt>Listings</dt>
            <dd className="mono">{compactNumber(directory.listings)}</dd>
            <dt>Verified</dt>
            <dd className="mono">{compactNumber(directory.verified)}</dd>
            <dt>Opt-outs</dt>
            <dd className="mono">{directory.optouts || 0}</dd>
            <dt>Countries</dt>
            <dd className="mono">{directory.countries}</dd>
          </dl>
        </Card>

        <Card title="Directions" subtitle="Last 7 days">
          {(stats?.dispositions || []).length ? (
            <div className="stack" style={{ gap: 8 }}>
              {stats.dispositions.map((row) => {
                const total = stats.dispositions.reduce((sum, r) => sum + r.count, 0) || 1;
                return (
                  <div key={row.disposition}>
                    <div className="row tiny" style={{ justifyContent: 'space-between', marginBottom: 3 }}>
                      <span className="muted">{row.disposition}</span>
                      <span className="dim mono">{row.count}</span>
                    </div>
                    <div style={{ height: 5, borderRadius: 3, background: 'rgba(255,255,255,.06)' }}>
                      <div
                        style={{
                          height: '100%',
                          width: `${Math.round((row.count / total) * 100)}%`,
                          borderRadius: 3,
                          background: row.disposition === 'answered' ? 'var(--success)' : 'var(--accent)',
                        }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <Empty icon="clock" title="No call data yet" />
          )}
        </Card>

        <Card title="Public surfaces" subtitle="One registry, six hostnames">
          <div className="stack" style={{ gap: 6 }}>
            {['telno.directory', 'num.directory', 'number.directory', 'directory.telno.services', 'directory.pbx.services', 'directory.pbx.technology'].map(
              (host) => (
                <a
                  key={host}
                  className="row tiny nav-item"
                  style={{ padding: '6px 8px' }}
                  href={`/d/${host}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  <Icon name="globe" size={13} />
                  <span className="truncate">{host}</span>
                  <Icon name="external" size={11} className="right dim" />
                </a>
              )
            )}
          </div>
        </Card>
      </div>
    </>
  );
}
