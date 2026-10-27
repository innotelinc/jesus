import { useEffect, useState } from 'react';
import { api, relativeTime } from '../api.js';
import { Badge, Button, Card, Empty, Icon, Input, Loading, Switch, useToast } from '../ui.jsx';
import { Link } from '../router.jsx';
import { useAuth } from '../auth.jsx';
import { BrandMark } from '../brand.jsx';
import { openSoftphoneWindow } from '../softphoneWindow.js';
import Softphone from './Softphone.jsx';

/**
 * The customer portal.
 *
 * A subscriber is not an operator: this renders the line they hold, the plan
 * they bought and the invoices addressed to them, and it is the only console a
 * customer account can reach. Every read here comes from `/api/me`, which
 * answers for the session and nothing else, so nothing on this page has to
 * filter anybody else's data out.
 */

const money = (cents, currency = 'USD') =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency }).format((cents || 0) / 100);

const day = (value) =>
  value
    ? new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' }).format(new Date(value))
    : '—';

const TABS = [
  { id: 'home', label: 'My line', icon: 'phone' },
  { id: 'invoices', label: 'Invoices', icon: 'card' },
  { id: 'plan', label: 'Plan', icon: 'tag' },
  { id: 'softphone', label: 'Softphone', icon: 'mic' },
];

export default function Customer() {
  const { user, logout } = useAuth();
  const toast = useToast();
  const [tab, setTab] = useState('home');
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const load = async () => {
    try {
      setData(await api.get('/me'));
    } catch (err) {
      toast.error('Could not load your account', err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const saveLine = async (lineId, patch) => {
    setSaving(true);
    try {
      const result = await api.patch(`/me/line/${lineId}`, patch);
      setData((current) => ({
        ...current,
        lines: current.lines.map((line) => (line.id === lineId ? result.line : line)),
      }));
      toast.success('Saved', 'Your line updates on the switch as soon as a call comes in.');
    } catch (err) {
      toast.error('Could not save that', err.message);
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="portal">
        <Loading rows={4} />
      </div>
    );
  }

  const lines = data?.lines || [];
  const open = (data?.invoices || []).filter((invoice) => ['open', 'overdue'].includes(invoice.status));
  const owed = open.reduce((total, invoice) => total + invoice.amount_cents, 0);

  return (
    <div className="portal">
      <header className="portal-top">
        <div className="row" style={{ gap: 10, alignItems: 'center', minWidth: 0 }}>
          <BrandMark />
          <div style={{ minWidth: 0 }}>
            <div className="truncate" style={{ fontWeight: 600 }}>
              {data?.brand?.name || 'Telno'}
            </div>
            <div className="tiny dim truncate">{user?.email}</div>
          </div>
        </div>
        <div className="row" style={{ gap: 8, alignItems: 'center' }}>
          <Badge tone={data?.entitlement?.active ? 'success' : 'warning'} dot="live">
            {data?.entitlement?.active ? data?.plan?.name || 'Active' : 'Needs attention'}
          </Badge>
          {lines.length ? (
            <Button size="sm" variant="ghost" icon="external" onClick={() => openSoftphoneWindow()}>
              Softphone window
            </Button>
          ) : null}
          <Button size="sm" variant="ghost" icon="logout" onClick={logout}>
            Sign out
          </Button>
        </div>
      </header>

      <nav className="portal-nav" aria-label="Account">
        {TABS.map((item) => (
          <button
            key={item.id}
            type="button"
            className={`portal-tab${tab === item.id ? ' on' : ''}`}
            aria-current={tab === item.id}
            onClick={() => setTab(item.id)}
          >
            <Icon name={item.icon} size={15} />
            {item.label}
            {item.id === 'invoices' && open.length ? <span className="portal-dot">{open.length}</span> : null}
          </button>
        ))}
      </nav>

      <main className="portal-body">
        {tab === 'home' ? (
          <>
            <div className="grid three">
              <Card title="Your plan" subtitle={data?.plan?.tagline || 'Subscription'}>
                <div className="stack">
                  <div className="row" style={{ gap: 8, alignItems: 'baseline' }}>
                    <strong style={{ fontSize: 22 }}>{data?.plan?.name || 'No plan'}</strong>
                    {data?.plan ? <span className="tiny dim">/{data.plan.interval}</span> : null}
                  </div>
                  <div className="tiny dim">
                    {data?.subscription?.currentPeriodEnd
                      ? `Paid through ${day(data.subscription.currentPeriodEnd)}`
                      : 'No paid period on file'}
                    {data?.subscription?.cancelAtPeriodEnd ? ' · cancels at period end' : ''}
                  </div>
                  <Badge tone={data?.entitlement?.active ? 'success' : 'warning'}>
                    {data?.entitlement?.reason || 'unknown'}
                  </Badge>
                </div>
              </Card>

              <Card title="Calls this month" subtitle="Unlimited calling, so nothing to count">
                <div className="tiny dim">
                  {(data?.plan?.minutesUnlimited || !data?.plan) && 'Unlimited minutes'}
                </div>
              </Card>

              <Card
                title="Balance"
                subtitle={open.length ? `${open.length} invoice${open.length === 1 ? '' : 's'} outstanding` : 'Nothing due'}
              >
                <div className="stack">
                  <strong style={{ fontSize: 22 }}>{money(owed, data?.payments?.currency)}</strong>
                  {open.length ? (
                    <Button size="sm" variant="primary" onClick={() => setTab('invoices')}>
                      Settle it
                    </Button>
                  ) : (
                    <span className="tiny dim">All paid up.</span>
                  )}
                </div>
              </Card>
            </div>

            {lines.length ? (
              lines.map((line) => (
                <Card
                  key={line.id}
                  title={line.displayName || `Line ${line.extension}`}
                  subtitle={line.number ? `${line.number} · extension ${line.extension}` : `Extension ${line.extension}`}
                  actions={
                    <Badge tone={line.enabled && !line.suspendedByBilling ? 'success' : 'warning'}>
                      {line.suspendedByBilling ? 'Suspended for billing' : line.enabled ? 'Live' : 'Off'}
                    </Badge>
                  }
                >
                  <div className="grid three">
                    <Input
                      label="What to call this line"
                      defaultValue={line.displayName}
                      onBlur={(event) => saveLine(line.id, { displayName: event.target.value })}
                    />
                    <Input
                      label="Forward calls to"
                      defaultValue={line.forwardTo}
                      placeholder="Another number or extension"
                      onBlur={(event) => saveLine(line.id, { forwardTo: event.target.value })}
                    />
                    <div className="stack" style={{ gap: 10 }}>
                      <Switch
                        checked={line.voicemail}
                        label="Voicemail"
                        onChange={(checked) => saveLine(line.id, { voicemail: checked })}
                      />
                      <Switch
                        checked={line.dnd}
                        label="Do not disturb"
                        onChange={(checked) => saveLine(line.id, { dnd: checked })}
                      />
                    </div>
                  </div>
                  <div className="row wrap" style={{ gap: 10, marginTop: 12 }}>
                    <Button size="sm" variant="primary" icon="phone" onClick={() => setTab('softphone')}>
                      Open the softphone
                    </Button>
                    <span className="tiny dim">
                      Encrypted (DTLS-SRTP). Your SIP secret is only ever sent to this browser session.
                    </span>
                  </div>
                </Card>
              ))
            ) : (
              <Card title="Your line" subtitle="Nothing assigned yet">
                <Empty icon="phone" title="No line on this account">
                  Your number is provisioned by the platform. Contact support and it will appear here, ready to take
                  calls and to register the softphone.
                </Empty>
              </Card>
            )}
          </>
        ) : null}

        {tab === 'invoices' ? (
          <Card title="Invoices" subtitle="Everything addressed to your account">
            {data?.invoices?.length ? (
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Invoice</th>
                      <th>Period</th>
                      <th>Due</th>
                      <th>Amount</th>
                      <th>Status</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {data.invoices.map((invoice) => (
                      <tr key={invoice.id}>
                        <td className="mono">{invoice.number}</td>
                        <td className="tiny dim">
                          {day(invoice.periodStart)} → {day(invoice.periodEnd)}
                        </td>
                        <td className="tiny dim">{day(invoice.dueAt)}</td>
                        <td>{money(invoice.amountCents, invoice.currency)}</td>
                        <td>
                          <Badge
                            tone={
                              invoice.status === 'paid'
                                ? 'success'
                                : invoice.status === 'overdue'
                                  ? 'danger'
                                  : invoice.status === 'open'
                                    ? 'warning'
                                    : 'neutral'
                            }
                          >
                            {invoice.status}
                          </Badge>
                        </td>
                        <td className="right">
                          {invoice.payUrl ? (
                            <a className="btn primary sm" href={invoice.payUrl}>
                              Pay now
                            </a>
                          ) : invoice.paidAt ? (
                            <span className="tiny dim">Paid {relativeTime(invoice.paidAt)}</span>
                          ) : null}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <Empty icon="card" title="No invoices yet">
                Your invoices appear here as soon as the first billing period closes.
              </Empty>
            )}
          </Card>
        ) : null}

        {tab === 'plan' ? (
          <>
            <Card
              title="Your subscription"
              subtitle={data?.plan ? `${money(data?.plan?.priceCents, data?.plan?.currency)} per ${data?.plan?.interval}` : 'No plan'}
            >
              <div className="stack">
                <div className="row wrap" style={{ gap: 6 }}>
                  {(data?.entitlement?.features || []).map((key) => (
                    <span key={key} className="badge neutral">
                      {String(key).replace(/-/g, ' ')}
                    </span>
                  ))}
                </div>
                <p className="tiny dim" style={{ margin: 0 }}>
                  {data?.subscription?.currentPeriodEnd
                    ? `Renews or ends on ${day(data.subscription.currentPeriodEnd)}.`
                    : 'No paid period on file.'}{' '}
                  Changing plan runs through Stripe checkout again, on the same email and password.
                </p>
                <div className="row" style={{ gap: 8 }}>
                  <Link className="btn sm" to="/subscribe">
                    Compare plans
                  </Link>
                  <Link className="btn ghost sm" to="/subscribe">
                    Change plan
                  </Link>
                </div>
              </div>
            </Card>

            <Card title="Data" subtitle="What this platform keeps about your line">
              <ul className="site-list">
                <li>Call detail records for your own numbers, kept for billing disputes.</li>
                <li>Voicemail audio and, when your plan includes it, call recordings.</li>
                <li>Your plan, invoices and payment references from Stripe.</li>
                <li>Nothing is sold or shared; the directory only lists numbers you submit.</li>
              </ul>
            </Card>
          </>
        ) : null}

        {tab === 'softphone' ? (
          <Card
            title="Softphone"
            subtitle="Register this browser as your own line"
            actions={
              lines.length ? (
                <Button size="sm" variant="ghost" icon="external" onClick={() => openSoftphoneWindow()}>
                  Pop out
                </Button>
              ) : null
            }
          >
            {lines.length ? (
              <Softphone />
            ) : (
              <Empty icon="phone" title="No line to register">
                Once a number is assigned to your account, the softphone registers here.
              </Empty>
            )}
          </Card>
        ) : null}
      </main>
    </div>
  );
}
