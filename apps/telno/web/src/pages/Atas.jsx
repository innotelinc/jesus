import { useEffect, useState } from 'react';
import { api, relativeTime } from '../api.js';
import { Badge, Button, Card, Loading, PageHeader, Stat, useToast } from '../ui.jsx';

/**
 * The boxes on the wall.
 *
 * An ATA is the only piece of the estate that has to work before anything else
 * can: if it never registers, its extension is unreachable and the switch has
 * nothing to ring — which looks exactly like a dial-plan bug and is not one.
 * So this page is separate from the estate's site inventory: it answers one
 * question per adapter, is the contact held right now, and it is reachable from
 * the sidebar rather than buried in a tab.
 *
 * The rows are the platform's own inventory, updated by the SIP border as each
 * adapter registers, so a device that has never reported in says so instead of
 * quietly claiming the status somebody typed when the row was created.
 */
const TONE = { online: 'success', provisioning: 'neutral', offline: 'danger', faulty: 'warning' };

export default function Atas() {
  const toast = useToast();
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = async ({ refresh = false } = {}) => {
    if (refresh) setRefreshing(true);
    try {
      const data = await api.get('/estate/devices?kind=ata');
      setItems(data.items);
    } catch (err) {
      toast.error('Could not load the ATAs', err.message);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  useEffect(() => {
    load();
    // A registration is a lease: it renews on the adapter's clock and expires on
    // its own, so the panel follows it rather than freezing at page load.
    const timer = setInterval(() => load(), 30_000);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const online = items.filter((device) => device.status === 'online').length;
  const waiting = items.filter((device) => device.status === 'provisioning').length;
  const silent = items.filter((device) => device.silent).length;

  return (
    <>
      <PageHeader
        title="ATA panel"
        subtitle="Every analog terminal adapter, the extension it carries, and whether the switch is holding its contact"
        actions={
          <Button variant="ghost" size="sm" onClick={() => load({ refresh: true })} disabled={refreshing}>
            {refreshing ? 'Refreshing…' : 'Refresh'}
          </Button>
        }
      />

      <div className="grid stats">
        <Stat label="ATAs" value={items.length} foot="On the inventory" />
        <Stat label="Registered" value={online} foot="Contact held by the switch" />
        <Stat label="Waiting" value={waiting} foot="Never reported in" />
        <Stat label="Silent" value={silent} foot="Registered, then went quiet" />
      </div>

      {loading ? (
        <Card>
          <Loading rows={3} />
        </Card>
      ) : items.length ? (
        <div className="grid three">
          {items.map((device) => (
            <Card
              key={device.id}
              title={device.name}
              subtitle={device.extension ? `Extension ${device.extension}` : 'No extension attached'}
              actions={<Badge tone={TONE[device.status] || 'neutral'}>{device.status}</Badge>}
            >
              <div className="stack">
                <div className="row wrap" style={{ gap: 10 }}>
                  <span className="tiny dim mono">{device.ip || 'no address yet'}</span>
                  <span className="tiny dim">·</span>
                  <span className="tiny dim mono">{device.mac || 'no MAC recorded'}</span>
                </div>
                <p className="tiny dim">
                  {device.lastSeenAt
                    ? `Last registered ${relativeTime(device.lastSeenAt)}`
                    : 'Has never registered with the switch'}
                </p>
                <p className="tiny dim">
                  {device.site || 'No site assigned'} · {device.model || 'model not recorded'}
                </p>
              </div>
            </Card>
          ))}
        </div>
      ) : (
        <Card title="No ATAs yet" subtitle="An adapter is a device on the inventory, attached to an extension">
          <p className="tiny dim">
            Add one under Estate with kind <span className="mono">ata</span>. It appears here the moment it is
            registered, and this panel shows the contact it holds from then on.
          </p>
          <a className="btn primary sm" href="/estate">
            Open the estate
          </a>
        </Card>
      )}
    </>
  );
}
