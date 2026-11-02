import { useEffect, useRef, useState } from 'react';
import { api, clockTime, duration, relativeTime } from '../api.js';
import { Badge, Button, Card, Empty, Icon, Loading, PageHeader, Stat, statusTone, useToast } from '../ui.jsx';

export default function Calls() {
  const [items, setItems] = useState([]);
  const [stats, setStats] = useState(null);
  const [direction, setDirection] = useState('');
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [clearing, setClearing] = useState(false);
  // Bumped after a clear so the effect reloads rather than waiting out the
  // 15 s poll with an empty table on screen.
  const [refresh, setRefresh] = useState(0);
  const debounce = useRef();
  const toast = useToast();

  useEffect(() => {
    const load = async () => {
      try {
        const [calls, statsData] = await Promise.all([
          api.get(`/calls?limit=60${direction ? `&direction=${direction}` : ''}${query ? `&q=${encodeURIComponent(query)}` : ''}`),
          api.get('/calls/stats'),
        ]);
        setItems(calls.items);
        setStats(statsData);
      } catch {
        /* surfaced by the empty state */
      } finally {
        setLoading(false);
      }
    };
    clearTimeout(debounce.current);
    debounce.current = setTimeout(load, query ? 280 : 0);
    const timer = setInterval(load, 15000);
    return () => {
      clearTimeout(debounce.current);
      clearInterval(timer);
    };
  }, [direction, query, refresh]);

  /**
   * Clear the whole log. The confirm is the guard: there is no undo, and the
   * rows are the only record that a call happened at all.
   */
  const clearHistory = async () => {
    if (!window.confirm('Clear the entire call history? This cannot be undone.')) return;
    setClearing(true);
    try {
      const result = await api.del('/calls');
      setItems([]);
      setStats(null);
      toast.success('Call history cleared', `${result?.cleared ?? 0} calls removed`);
      setRefresh((value) => value + 1);
    } catch (err) {
      toast.error('Could not clear the call history', err.message);
    } finally {
      setClearing(false);
    }
  };

  const last24 = stats?.last24h || { total: 0, answered: 0, missed: 0, avgTalk: 0 };
  const rate = last24.total ? Math.round((last24.answered / last24.total) * 100) : 0;

  return (
    <>
      <PageHeader title="Call history" subtitle="Ingested from the Cantus switch; idempotent on call id" />

      <div className="grid stats">
        <Stat label="Last 24h" value={last24.total} foot="All directions" />
        <Stat label="Answered" value={last24.answered} foot={`${rate}% answer rate`} />
        <Stat label="Missed" value={last24.missed} foot="No answer, busy or failed" tone={last24.missed ? 'var(--warning)' : undefined} />
        <Stat label="Avg talk" value={duration(last24.avgTalk)} foot="Answered calls only" />
      </div>

      <Card bodyClass="tight">
        <div className="row wrap" style={{ padding: 12, gap: 8 }}>
          <div className="search">
            <Icon name="search" size={14} />
            <input
              className="input"
              placeholder="Filter by number or extension…"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              aria-label="Filter calls"
            />
          </div>
          <select
            className="select"
            style={{ width: 160 }}
            value={direction}
            onChange={(event) => setDirection(event.target.value)}
            aria-label="Filter by direction"
          >
            <option value="">All directions</option>
            <option value="inbound">Inbound</option>
            <option value="outbound">Outbound</option>
            <option value="internal">Internal</option>
          </select>
          {stats?.active > 0 ? <Badge tone="success" dot="live">{stats.active} live</Badge> : null}
          <div className="spacer" style={{ flex: 1 }} />
          <Button
            size="sm"
            variant="ghost"
            icon="trash"
            loading={clearing}
            disabled={!items.length}
            onClick={clearHistory}
            title={items.length ? 'Delete every row in the call log' : 'The call log is already empty'}
          >
            Clear history
          </Button>
        </div>

        {loading ? (
          <div style={{ padding: 16 }}>
            <Loading rows={5} />
          </div>
        ) : items.length ? (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Direction</th>
                  <th>From</th>
                  <th>To</th>
                  <th>Ext</th>
                  <th>Trunk</th>
                  <th>Started</th>
                  <th className="align-right">Talk</th>
                  <th>Recording</th>
                  <th>Result</th>
                </tr>
              </thead>
              <tbody>
                {items.map((call) => (
                  <tr key={call.id}>
                    <td>
                      <span className="row" style={{ gap: 5 }}>
                        <Icon
                          name={call.direction === 'inbound' ? 'arrowDown' : call.direction === 'outbound' ? 'arrowUp' : 'branch'}
                          size={13}
                        />
                        <span className="tiny muted">{call.direction}</span>
                      </span>
                    </td>
                    <td className="num tiny nowrap">{call.from || '—'}</td>
                    <td className="num tiny nowrap">{call.to || '—'}</td>
                    <td className="tiny mono">{call.extension || '—'}</td>
                    <td className="tiny dim">{call.trunk || '—'}</td>
                    <td className="tiny dim nowrap" title={call.startedAt}>
                      {clockTime(call.startedAt)} · {relativeTime(call.startedAt)}
                    </td>
                    <td className="align-right tiny mono">{duration(call.billsec || call.duration)}</td>
                    <td>
                      {call.recording ? (
                        <audio
                          controls
                          preload="none"
                          src={call.audioUrl}
                          style={{ width: 190, height: 30 }}
                          aria-label={`Recording of the call with ${call.from || call.to}`}
                        />
                      ) : (
                        <span className="tiny dim">—</span>
                      )}
                    </td>
                    <td>
                      <Badge tone={statusTone(call.disposition)}>{call.disposition}</Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty icon="calls" title="No calls recorded">
            The platform writes a row per leg from the switch's own events. Place a test call, or run the seed for demo data.
          </Empty>
        )}
      </Card>
    </>
  );
}
