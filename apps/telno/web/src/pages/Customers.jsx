import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, qs, relativeTime, duration, prettyNumber } from '../api.js';
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
  Textarea,
  useToast,
} from '../ui.jsx';

/* ------------------------------------------------------------- formatting -- */

const money = (cents, currency = 'USD') =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency, maximumFractionDigits: 2 }).format((cents || 0) / 100);

const PRIORITY_TONE = { urgent: 'danger', high: 'warning', normal: 'info', low: 'neutral' };
const TICKET_TONE = { open: 'info', pending: 'warning', resolved: 'success', closed: 'neutral' };
const PLAN_TONE = { active: 'success', trialing: 'info', past_due: 'warning', canceled: 'neutral', unpaid: 'danger' };
const KIND_LABEL = {
  support: 'Support',
  billing: 'Billing',
  complaint: 'Complaint',
  service_change: 'Service change',
  porting: 'Porting',
  outage: 'Outage',
};

const dateOf = (value) => (value ? new Date(value).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—');

/**
 * The customer panel.
 *
 * One page, two questions: who is this customer and what is happening with them
 * (the list and the 360 view), and what is waiting on us (the ticket queue).
 * Everything shown is read back from the platform — the plan is the subscription
 * that was sold, the balance is the sum of unpaid invoices, calls are the switch's
 * own records — so this panel can never disagree with what a customer sees.
 */
export default function Customers() {
  const toast = useToast();
  const [tab, setTab] = useState('customers');
  const [overview, setOverview] = useState(null);
  const [meta, setMeta] = useState({ categories: [], priorities: [], states: [], paymentMethods: [], plans: [], assignees: [] });
  const [list, setList] = useState({ items: [], total: 0 });
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');
  const [state, setState] = useState('');
  const [plan, setPlan] = useState('');
  const [sort, setSort] = useState('attention');

  const [selectedId, setSelectedId] = useState('');
  const [detail, setDetail] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [view, setView] = useState('overview');

  const [queue, setQueue] = useState({ items: [], summary: null, total: 0 });
  const [queueFilter, setQueueFilter] = useState({ state: 'open', priority: '', category: '', q: '' });
  const [queueLoading, setQueueLoading] = useState(false);

  const [busy, setBusy] = useState('');
  const [note, setNote] = useState('');
  const [reply, setReply] = useState('');
  const [ticketId, setTicketId] = useState('');
  const [ticket, setTicket] = useState(null);

  const [editOpen, setEditOpen] = useState(false);
  const [profile, setProfile] = useState({});
  const [payOpen, setPayOpen] = useState(false);
  // The one confirmation dialog the four lifecycle actions share. Three of them
  // are not reversible from this screen, so the dialog states the consequence
  // rather than asking "are you sure".
  const [lifecycle, setLifecycle] = useState(null);
  const [payment, setPayment] = useState({ invoiceId: '', amount: '', method: 'manual', reference: '', note: '' });
  const [newTicket, setNewTicket] = useState(null);

  const loadOverview = useCallback(async () => {
    try {
      setOverview(await api.get('/crm/overview'));
    } catch (err) {
      toast.error('Could not load the panel totals', err.message);
    }
  }, [toast]);

  const loadList = useCallback(async () => {
    setLoading(true);
    try {
      setList(await api.get(`/crm/customers${qs({ q: query, state, plan, sort, limit: 50 })}`));
    } catch (err) {
      toast.error('Could not load customers', err.message);
    } finally {
      setLoading(false);
    }
  }, [query, state, plan, sort, toast]);

  const loadQueue = useCallback(async () => {
    setQueueLoading(true);
    try {
      setQueue(await api.get(`/crm/tickets${qs({ ...queueFilter, limit: 100 })}`));
    } catch (err) {
      toast.error('Could not load the ticket queue', err.message);
    } finally {
      setQueueLoading(false);
    }
  }, [queueFilter, toast]);

  useEffect(() => {
    api.get('/crm/meta').then(setMeta).catch(() => {});
    loadOverview();
  }, [loadOverview]);

  useEffect(() => {
    const timer = setTimeout(loadList, query ? 250 : 0);
    return () => clearTimeout(timer);
  }, [loadList, query]);

  useEffect(() => {
    if (tab === 'tickets') loadQueue();
  }, [tab, loadQueue]);

  const select = useCallback(
    async (id) => {
      setSelectedId(id);
      setDetailLoading(true);
      setView('overview');
      setTicketId('');
      try {
        setDetail(await api.get(`/crm/customers/${id}`));
      } catch (err) {
        toast.error('Could not load that customer', err.message);
        setDetail(null);
      } finally {
        setDetailLoading(false);
      }
    },
    [toast]
  );

  const refresh = () => {
    loadOverview();
    loadList();
    if (selectedId) select(selectedId);
    if (tab === 'tickets') loadQueue();
  };

  const openTicket = async (id) => {
    setTicketId(id);
    try {
      setTicket(await api.get(`/crm/tickets/${id}`));
    } catch (err) {
      toast.error('Could not open that ticket', err.message);
    }
  };

  const areload = async () => {
    await Promise.all([loadOverview(), loadList(), tab === 'tickets' ? loadQueue() : Promise.resolve()]);
    if (selectedId) {
      try {
        setDetail(await api.get(`/crm/customers/${selectedId}`));
      } catch {
        /* the selected customer may have been removed in another tab */
      }
    }
    if (ticketId) {
      try {
        setTicket(await api.get(`/crm/tickets/${ticketId}`));
      } catch {
        setTicketId('');
        setTicket(null);
      }
    }
  };

  const saveNote = async () => {
    if (!selectedId || !note.trim()) return;
    setBusy('note');
    try {
      await api.post(`/crm/customers/${selectedId}/notes`, { body: note });
      setNote('');
      toast.success('Note saved');
      await areload();
    } catch (err) {
      toast.error('Could not save the note', err.message);
    } finally {
      setBusy('');
    }
  };

  const saveProfile = async () => {
    setBusy('profile');
    try {
      const data = await api.patch(`/crm/customers/${selectedId}`, profile);
      setDetail((current) => (current ? { ...current, customer: data.customer } : current));
      setEditOpen(false);
      toast.success('Customer details updated');
      loadList();
    } catch (err) {
      toast.error('Could not update the customer', err.message);
    } finally {
      setBusy('');
    }
  };

  const LIFECYCLE_COPY = {
    suspend: {
      verb: 'Suspend',
      title: 'Suspend this customer',
      detail:
        'They keep their account, numbers and history, and lose the ability to sign in — every open session stops working now. Reversible with Reinstate.',
      done: 'Customer suspended',
      failed: 'Could not suspend the customer',
    },
    reinstate: {
      verb: 'Reinstate',
      title: 'Reinstate this customer',
      detail:
        'The suspension is lifted and they can sign in again. Their previous sessions were invalidated, so they will need to sign in once more.',
      done: 'Customer reinstated',
      failed: 'Could not reinstate the customer',
    },
    cancel: {
      verb: 'Cancel plan',
      title: 'Cancel what this customer pays for',
      detail:
        'The subscription stops renewing. The account, its lines and its invoices stay, and the paid gate closes on its own because access reads the subscription.',
      done: 'Subscription cancelled',
      failed: 'Could not cancel the subscription',
    },
    remove: {
      verb: 'Remove customer',
      title: 'Remove this customer entirely',
      detail:
        'The account is deleted, along with its subscription, keys and lines. This cannot be undone from here — suspend or cancel instead if the history matters.',
      done: 'Customer removed',
      failed: 'Could not remove the customer',
    },
  };

  const runLifecycle = async () => {
    if (!lifecycle || !selectedId) return;
    setBusy('lifecycle');
    try {
      if (lifecycle.action === 'remove') {
        await api.del(`/customers/${selectedId}`);
        setSelectedId('');
        setDetail(null);
      } else {
        await api.post(`/customers/${selectedId}/${lifecycle.action}`, {
          reason: lifecycle.reason || undefined,
        });
      }
      toast.success(LIFECYCLE_COPY[lifecycle.action].done);
      setLifecycle(null);
      await areload();
      loadList();
    } catch (err) {
      // A 409 here is the "active subscription" refusal, which is the API
      // telling the operator to cancel first — say that, not "request failed".
      toast.error(LIFECYCLE_COPY[lifecycle.action].failed, err.message);
    } finally {
      setBusy('');
    }
  };

  const recordPayment = async () => {
    setBusy('payment');
    try {
      const cents = Math.round(Number(payment.amount) * 100);
      await api.post(`/crm/customers/${selectedId}/payments`, {
        invoiceId: payment.invoiceId || undefined,
        amountCents: cents,
        method: payment.method,
        reference: payment.reference,
        note: payment.note,
      });
      setPayOpen(false);
      setPayment({ invoiceId: '', amount: '', method: 'manual', reference: '', note: '' });
      toast.success('Payment recorded', cents > 0 ? `${money(cents)} collected` : undefined);
      await areload();
    } catch (err) {
      toast.error('Could not record the payment', err.message);
    } finally {
      setBusy('');
    }
  };

  /**
   * Ask Stripe for the plan charges it already collected.
   *
   * A subscription is billed by Stripe, so the webhook is what normally writes
   * the money into the ledger. This is the repair for the charges from before the
   * webhook was listening — a customer can have paid for months with nothing
   * recorded against them.
   */
  const syncStripeCharges = async () => {
    if (!selectedId) return;
    setBusy('stripe-sync');
    try {
      const result = await api.post(`/crm/customers/${selectedId}/payments/sync`, {});
      toast.success(
        result.recorded ? `${result.recorded} charge${result.recorded === 1 ? '' : 's'} added` : 'Already up to date',
        `${result.scanned} paid invoice${result.scanned === 1 ? '' : 's'} at Stripe`
      );
      await areload();
    } catch (err) {
      toast.error('Could not read Stripe', err.message);
    } finally {
      setBusy('');
    }
  };

  const createTicket = async () => {
    setBusy('ticket');
    try {
      const created = await api.post('/crm/tickets', newTicket);
      setNewTicket(null);
      toast.success('Ticket opened', created.ticket?.subject);
      await areload();
      openTicket(created.ticket.id);
    } catch (err) {
      toast.error('Could not open the ticket', err.message);
    } finally {
      setBusy('');
    }
  };

  const moveTicket = async (patch) => {
    if (!ticketId) return;
    setBusy('move');
    try {
      const data = await api.patch(`/crm/tickets/${ticketId}`, patch);
      setTicket(data);
      await areload();
    } catch (err) {
      toast.error('Could not update the ticket', err.message);
    } finally {
      setBusy('');
    }
  };

  const sendReply = async (kind = 'note') => {
    if (!ticketId || !reply.trim()) return;
    setBusy('reply');
    try {
      const data = await api.post(`/crm/tickets/${ticketId}/notes`, { body: reply, kind });
      setTicket(data);
      setReply('');
      await areload();
    } catch (err) {
      toast.error('Could not add that note', err.message);
    } finally {
      setBusy('');
    }
  };

  const customer = detail?.customer || null;
  const currency = detail?.billing?.currency || 'USD';
  const planOptions = useMemo(() => list.plans || [], [list.plans]);

  const queueTabs = [
    { value: 'open', label: 'Waiting', count: queue.summary ? queue.summary.open + queue.summary.pending : undefined },
    { value: 'resolved', label: 'Resolved' },
    { value: '', label: 'All' },
  ];

  return (
    <>
      <PageHeader
        title="Customers"
        subtitle="Who they are, what they have, what they owe, and what is waiting on us"
        actions={
          <>
            <Button variant="ghost" icon="refresh" onClick={refresh}>
              Refresh
            </Button>
            <Button
              variant="primary"
              icon="plus"
              onClick={() =>
                setNewTicket({
                  subject: '',
                  description: '',
                  category: 'support',
                  priority: 'normal',
                  assignee: '',
                  accountId: customer?.id || '',
                })
              }
            >
              New ticket
            </Button>
          </>
        }
      />

      <div className="grid stats">
        <Stat label="Customers" value={overview?.customers ?? '—'} foot={`${overview?.newThisMonth ?? 0} new this month`} />
        <Stat
          label="Monthly recurring"
          value={overview ? money(overview.mrrCents, overview.currency) : '—'}
          foot={`${overview?.activeSubscriptions ?? 0} active subscriptions`}
        />
        <Stat
          label="Outstanding"
          value={overview ? money(overview.outstandingCents, overview.currency) : '—'}
          foot={`${overview ? money(overview.overdueCents, overview.currency) : '—'} past due`}
          tone={overview?.overdueCents ? 'var(--warning)' : undefined}
        />
        <Stat
          label="Waiting on us"
          value={overview?.openTickets ?? '—'}
          foot={`${overview?.breachingTickets ?? 0} past their due date`}
          tone={overview?.breachingTickets ? 'var(--danger)' : undefined}
        />
      </div>

      <Tabs
        tabs={[
          { value: 'customers', label: 'Customers', count: overview?.customers },
          { value: 'tickets', label: 'Ticket queue', count: overview?.openTickets },
        ]}
        value={tab}
        onChange={setTab}
      />

      {tab === 'customers' ? (
        <div className="grid two">
          <Card
            title={`Directory (${list.total})`}
            subtitle="Sorted by what needs attention first"
            actions={<Button size="icon" variant="ghost" icon="search" aria-label="Reload" onClick={loadList} />}
          >
            <div className="stack" style={{ gap: 8 }}>
              <Input
                placeholder="Search name, company, email or phone"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
              <div className="row wrap" style={{ gap: 8 }}>
                <Select value={state} onChange={(event) => setState(event.target.value)} aria-label="Filter by standing">
                  <option value="">Any standing</option>
                  <option value="active">Active</option>
                  <option value="past_due">Past due</option>
                  <option value="suspended">Suspended</option>
                  <option value="tickets">Open tickets</option>
                  <option value="unverified">Unverified</option>
                  <option value="no_plan">No plan</option>
                </Select>
                <Select value={plan} onChange={(event) => setPlan(event.target.value)} aria-label="Filter by plan">
                  <option value="">Any plan</option>
                  {planOptions.map((row) => (
                    <option key={row.slug} value={row.slug}>
                      {row.name}
                    </option>
                  ))}
                </Select>
                <Select value={sort} onChange={(event) => setSort(event.target.value)} aria-label="Sort by">
                  <option value="attention">Attention</option>
                  <option value="recent">Newest</option>
                  <option value="balance">Balance</option>
                  <option value="tickets">Tickets</option>
                  <option value="name">Name</option>
                </Select>
              </div>
            </div>

            {loading ? (
              <Loading rows={5} />
            ) : list.items.length ? (
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Customer</th>
                      <th>Plan</th>
                      <th className="align-right">Balance</th>
                    </tr>
                  </thead>
                  <tbody>
                    {list.items.map((row) => (
                      <tr
                        key={row.id}
                        className="clickable"
                        onClick={() => select(row.id)}
                        style={row.id === selectedId ? { background: 'rgba(111, 102, 255, 0.10)' } : undefined}
                      >
                        <td>
                          <strong style={{ fontSize: '0.8125rem' }}>{row.name || row.company || row.email}</strong>
                          <div className="tiny dim">
                            {row.company && row.name ? `${row.company} · ` : ''}
                            {row.email}
                          </div>
                          <div className="row wrap" style={{ gap: 4, marginTop: 4 }}>
                            {row.openTickets ? <Badge tone="warning">{row.openTickets} ticket{row.openTickets > 1 ? 's' : ''}</Badge> : null}
                            {row.overdueCents ? <Badge tone="danger">Past due</Badge> : null}
                            {row.suspendedAt ? <Badge tone="danger">Suspended</Badge> : null}
                            {!row.verified.email || !row.verified.phone ? <Badge tone="neutral">Unverified</Badge> : null}
                          </div>
                        </td>
                        <td>
                          {row.plan ? (
                            <>
                              <div className="tiny">{row.plan.name}</div>
                              <Badge tone={PLAN_TONE[row.plan.status] || 'neutral'}>{row.plan.status}</Badge>
                            </>
                          ) : (
                            <span className="tiny dim">No plan</span>
                          )}
                        </td>
                        <td className="num align-right">
                          {money(row.balanceCents, row.plan?.currency || 'USD')}
                          {row.overdueCents ? (
                            <div className="tiny" style={{ color: 'var(--danger)' }}>
                              {money(row.overdueCents, row.plan?.currency || 'USD')} late
                            </div>
                          ) : null}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <Empty icon="users" title="No customers match">
                Try a different filter, or clear the search.
              </Empty>
            )}
          </Card>

          <Card
            title={customer ? customer.name || customer.company || customer.email : 'No customer selected'}
            subtitle={customer ? customer.email : 'Pick someone from the directory to see everything about them'}
            actions={
              customer ? (
                <>
                  <Button size="sm" variant="ghost" icon="edit" onClick={() => { setProfile({
                    name: customer.name, company: customer.company, phone: customer.phone,
                    address: detail.profile.address, city: customer.city, country: customer.country,
                    website: customer.website,
                  }); setEditOpen(true); }}>
                    Edit
                  </Button>
                  <Button size="sm" variant="ghost" icon="card" onClick={() => setPayOpen(true)}>
                    Payment
                  </Button>
                  <Button size="sm" variant="ghost" icon="plus" onClick={() => setNewTicket({ subject: '', description: '', category: 'support', priority: 'normal', assignee: '', accountId: customer.id })}>
                    Ticket
                  </Button>
                  {detail?.customer?.suspendedAt ? (
                    <Button size="sm" variant="ghost" onClick={() => setLifecycle({ action: 'reinstate' })}>
                      Reinstate
                    </Button>
                  ) : (
                    <Button size="sm" variant="ghost" onClick={() => setLifecycle({ action: 'suspend' })}>
                      Suspend
                    </Button>
                  )}
                  {detail?.subscription && detail.subscription.status !== 'canceled' ? (
                    <Button size="sm" variant="ghost" onClick={() => setLifecycle({ action: 'cancel' })}>
                      Cancel plan
                    </Button>
                  ) : null}
                  <Button size="sm" variant="danger" onClick={() => setLifecycle({ action: 'remove' })}>
                    Remove
                  </Button>
                </>
              ) : null
            }
          >
            {detailLoading ? (
              <Loading rows={6} />
            ) : !detail ? (
              <Empty icon="users" title="Nothing selected">
                The 360 view shows the plan, the lines, the bills, the calls, the tickets and the notes together.
              </Empty>
            ) : (
              <div className="stack">
                <div className="row wrap" style={{ gap: 6 }}>
                  {detail.subscription ? (
                    <Badge tone={PLAN_TONE[detail.subscription.status] || 'neutral'}>{detail.subscription.status}</Badge>
                  ) : (
                    <Badge tone="neutral">No plan</Badge>
                  )}
                  {detail.customer.suspendedAt ? <Badge tone="danger">Suspended</Badge> : null}
                  {!detail.entitlement.active ? <Badge tone="warning">Access: {detail.entitlement.reason.replace(/_/g, ' ')}</Badge> : null}
                  {detail.customer.dunning.state !== 'current' ? <Badge tone="warning">Dunning: {detail.customer.dunning.state}</Badge> : null}
                </div>

                <Tabs
                  tabs={[
                    { value: 'overview', label: 'Overview' },
                    { value: 'services', label: 'Services', count: detail.lines.length },
                    { value: 'billing', label: 'Billing', count: detail.billing.invoices.length },
                    { value: 'calls', label: 'Calls', count: detail.calls.length },
                    { value: 'tickets', label: 'Tickets', count: detail.tickets.length },
                    { value: 'notes', label: 'Notes', count: detail.notes.length },
                  ]}
                  value={view}
                  onChange={setView}
                />

                {view === 'overview' ? (
                  <div className="stack">
                    <dl className="kv">
                      <dt>Contact</dt>
                      <dd>{customer.phone || '—'}</dd>
                      <dt>Company</dt>
                      <dd>{customer.company || '—'}</dd>
                      <dt>Address</dt>
                      <dd>{[detail.profile.address, customer.city, customer.country].filter(Boolean).join(', ') || '—'}</dd>
                      <dt>Website</dt>
                      <dd>{customer.website || '—'}</dd>
                      <dt>Plan</dt>
                      <dd>{detail.subscription ? `${detail.subscription.planName} · ${money(detail.subscription.priceCents, detail.subscription.currency)}/${detail.subscription.interval}` : 'No plan'}</dd>
                      <dt>Renews</dt>
                      {/* The API hands back an ISO instant, not an epoch second. */}
                      <dd>{detail.subscription?.currentPeriodEnd ? dateOf(detail.subscription.currentPeriodEnd) : '—'}</dd>
                      <dt>Verified</dt>
                      <dd>
                        {detail.profile.emailVerifiedAt ? 'Email' : 'Email not proved'}
                        {' · '}
                        {detail.profile.phoneVerifiedAt ? 'Phone' : 'Phone not proved'}
                        {detail.profile.termsAcceptedAt ? ' · Terms accepted' : ' · Terms not accepted'}
                      </dd>
                      <dt>Directory</dt>
                      <dd>{detail.profile.directoryOptIn ? `Listed as ${detail.profile.listingKind}` : 'Not listed'}</dd>
                      <dt>Customer since</dt>
                      <dd>{dateOf(customer.createdAt)}</dd>
                      <dt>Balance</dt>
                      <dd>
                        {money(detail.billing.balanceCents, currency)}
                        {detail.billing.overdueCents ? ` · ${money(detail.billing.overdueCents, currency)} late` : ''}
                        {' · '}
                        {money(detail.billing.collectedCents, currency)} collected
                      </dd>
                    </dl>

                    <div>
                      <h3 style={{ fontSize: '0.8125rem', marginBottom: 6 }}>Recent activity</h3>
                      <div className="stack" style={{ gap: 8 }}>
                        {detail.activity.length ? (
                          detail.activity.slice(0, 14).map((item, index) => (
                            <div key={`${item.at}-${index}`} className="row" style={{ gap: 10, alignItems: 'flex-start' }}>
                              <span className="tiny dim" style={{ width: 78, flex: '0 0 78px' }}>
                                {relativeTime(item.at)}
                              </span>
                              <span className="tiny" style={{ minWidth: 0 }}>
                                <strong>{item.title}</strong>
                                {item.detail ? <span className="dim"> — {item.detail}</span> : null}
                              </span>
                            </div>
                          ))
                        ) : (
                          <p className="tiny dim">Nothing recorded yet.</p>
                        )}
                      </div>
                    </div>
                  </div>
                ) : null}

                {view === 'services' ? (
                  <div className="table-wrap">
                    {detail.lines.length ? (
                      <table className="table">
                        <thead>
                          <tr>
                            <th>Number</th>
                            <th>Line</th>
                            <th>Handling</th>
                            <th className="align-right">Rent</th>
                          </tr>
                        </thead>
                        <tbody>
                          {detail.lines.map((line) => (
                            <tr key={line.id}>
                              <td>
                                <strong style={{ fontFamily: 'var(--mono)', fontSize: '0.78rem' }}>{prettyNumber(line.e164) || line.e164}</strong>
                                <div className="tiny dim">{line.provider || 'entered by hand'}</div>
                              </td>
                              <td className="tiny">
                                {line.ext || '—'} {line.displayName ? `· ${line.displayName}` : ''}
                                <div className="row wrap" style={{ gap: 4, marginTop: 3 }}>
                                  {line.releasedAt ? <Badge tone="neutral">Released</Badge> : null}
                                  {line.scif ? <Badge tone="info">SCIF</Badge> : null}
                                  {line.lineEnabled === false ? <Badge tone="warning">Suspended</Badge> : null}
                                  {line.voicemail ? <Badge tone="neutral">Voicemail</Badge> : null}
                                </div>
                              </td>
                              <td className="tiny">{line.faxMode === 'voice' ? 'Voice' : line.faxMode === 'fax' ? 'Fax only' : 'Voice + T.38 fax'}</td>
                              <td className="num align-right">{money(line.monthlyCostCents, currency)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    ) : (
                      <p className="tiny dim">No numbers on this account.</p>
                    )}
                  </div>
                ) : null}

                {view === 'billing' ? (
                  <div className="stack">
                    {/* A card subscription is collected by Stripe and deliberately
                        gets no statement here, so an empty list next to "$0.00
                        collected" would read as a customer who never paid. Say
                        which half of the bill this table is. */}
                    {detail.subscription?.stripeSubscriptionId ? (
                      <p className="tiny dim" style={{ margin: 0 }}>
                        The {detail.subscription.planName} fee is charged to the card on file at Stripe and is not on a
                        statement here. Rent and any one-off charges are billed below.
                      </p>
                    ) : null}
                    <div className="table-wrap">
                      {detail.billing.invoices.length ? (
                        <table className="table">
                          <thead>
                            <tr>
                              <th>Invoice</th>
                              <th>Issued</th>
                              <th>Status</th>
                              <th className="align-right">Amount</th>
                            </tr>
                          </thead>
                          <tbody>
                            {detail.billing.invoices.map((invoice) => (
                              <tr key={invoice.id}>
                                <td>
                                  <strong style={{ fontSize: '0.78rem' }}>{invoice.number}</strong>
                                  <div className="tiny dim">
                                    {invoice.items.map((item) => item.description).join(' · ') || 'no lines'}
                                  </div>
                                </td>
                                <td className="tiny">{dateOf(invoice.issuedAt || invoice.periodStart)}</td>
                                <td>
                                  <Badge tone={invoice.status === 'paid' ? 'success' : invoice.status === 'overdue' ? 'danger' : invoice.status === 'void' ? 'neutral' : 'info'}>
                                    {invoice.status}
                                  </Badge>
                                </td>
                                <td className="num align-right">{money(invoice.amountCents, invoice.currency)}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      ) : (
                        <p className="tiny dim">No invoices yet.</p>
                      )}
                    </div>

                    <div>
                      <div className="row wrap" style={{ gap: 8, marginBottom: 6 }}>
                        <h3 style={{ fontSize: '0.8125rem' }}>Payments collected</h3>
                        <Button
                          size="sm"
                          variant="ghost"
                          icon="refresh"
                          loading={busy === 'stripe-sync'}
                          style={{ marginLeft: 'auto' }}
                          onClick={syncStripeCharges}
                        >
                          Sync from Stripe
                        </Button>
                      </div>
                      {detail.billing.payments.length ? (
                        <div className="stack" style={{ gap: 6 }}>
                          {detail.billing.payments.map((row) => (
                            <div key={row.id} className="row" style={{ gap: 8 }}>
                              <span className="tiny">{dateOf(row.receivedAt)}</span>
                              <Badge tone={row.method === 'refund' || row.amountCents < 0 ? 'danger' : 'success'}>{row.method}</Badge>
                              <span className="tiny dim" style={{ minWidth: 0 }}>
                                {row.note || 'no note'}
                                {row.reference ? (
                                  <span style={{ fontFamily: 'var(--mono)', marginLeft: 6 }}>{row.reference}</span>
                                ) : null}
                              </span>
                              <strong className="tiny" style={{ marginLeft: 'auto' }}>{money(row.amountCents, row.currency)}</strong>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <p className="tiny dim">
                          Nothing collected yet. Plan fees are charged by card at Stripe, so press Sync to pull what
                          Stripe has already taken.
                        </p>
                      )}
                    </div>
                  </div>
                ) : null}

                {view === 'calls' ? (
                  <div className="table-wrap">
                    {detail.calls.length ? (
                      <table className="table">
                        <thead>
                          <tr>
                            <th>When</th>
                            <th>From → To</th>
                            <th>Result</th>
                            <th className="align-right">Talk</th>
                          </tr>
                        </thead>
                        <tbody>
                          {detail.calls.map((call) => (
                            <tr key={call.id}>
                              <td className="tiny">{relativeTime(call.startedAt)}</td>
                              <td className="tiny" style={{ fontFamily: 'var(--mono)', fontSize: '0.74rem' }}>
                                {prettyNumber(call.from)} → {prettyNumber(call.to)}
                              </td>
                              <td>
                                <Badge tone={call.disposition === 'answered' ? 'success' : 'neutral'}>{call.disposition || 'unknown'}</Badge>
                              </td>
                              <td className="num align-right tiny">{call.billsec ? duration(call.billsec) : '—'}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    ) : (
                      <p className="tiny dim">No calls recorded with this customer's lines.</p>
                    )}
                  </div>
                ) : null}

                {view === 'tickets' ? (
                  <div className="stack" style={{ gap: 8 }}>
                    {detail.tickets.length ? (
                      detail.tickets.map((row) => (
                        <button
                          key={row.id}
                          type="button"
                          className="panel"
                          style={{ padding: 10, textAlign: 'left' }}
                          onClick={() => openTicket(row.id)}
                        >
                          <div className="row" style={{ gap: 8 }}>
                            <strong className="tiny">{row.subject}</strong>
                            <Badge tone={PRIORITY_TONE[row.priority]}>{row.priority}</Badge>
                            <span style={{ marginLeft: 'auto' }}>
                              <Badge tone={TICKET_TONE[row.state]}>{row.state}</Badge>
                            </span>
                          </div>
                          <div className="tiny dim" style={{ marginTop: 3 }}>
                            {KIND_LABEL[row.category] || row.category} · opened {relativeTime(row.createdAt)}
                            {row.assignee ? ` · ${row.assignee}` : ' · unassigned'}
                            {row.overdue ? ' · past due' : ''}
                          </div>
                        </button>
                      ))
                    ) : (
                      <p className="tiny dim">No tickets. Nothing outstanding.</p>
                    )}
                  </div>
                ) : null}

                {view === 'notes' ? (
                  <div className="stack">
                    <Textarea label="Add a note" rows={3} value={note} onChange={(event) => setNote(event.target.value)} placeholder="Called about the porting date; agreed to move it a week." />
                    <div className="row">
                      <Button size="sm" variant="primary" loading={busy === 'note'} disabled={!note.trim()} onClick={saveNote}>
                        Save note
                      </Button>
                    </div>
                    <div className="stack" style={{ gap: 8 }}>
                      {detail.notes.length ? (
                        detail.notes.map((row) => (
                          <div key={row.id} className="panel" style={{ padding: 10 }}>
                            <div className="tiny dim">
                              {row.actor || 'someone'} · {relativeTime(row.at)}
                            </div>
                            <p className="tiny" style={{ marginTop: 4 }}>{row.body}</p>
                          </div>
                        ))
                      ) : (
                        <p className="tiny dim">No notes yet.</p>
                      )}
                    </div>
                  </div>
                ) : null}
              </div>
            )}
          </Card>
        </div>
      ) : (
        <div className="stack">
          <Card
            title="Ticket queue"
            subtitle="Worked by what is due and how urgent it is, not by what arrived first"
            actions={<Button size="sm" variant="ghost" icon="refresh" onClick={loadQueue}>Refresh</Button>}
          >
            <div className="stack" style={{ gap: 8 }}>
              <Tabs tabs={queueTabs} value={queueFilter.state} onChange={(value) => setQueueFilter({ ...queueFilter, state: value })} />
              <div className="row wrap" style={{ gap: 8 }}>
                <Input placeholder="Search subject, name or email" value={queueFilter.q} onChange={(event) => setQueueFilter({ ...queueFilter, q: event.target.value })} />
                <Select value={queueFilter.priority} onChange={(event) => setQueueFilter({ ...queueFilter, priority: event.target.value })} aria-label="Priority">
                  <option value="">Any priority</option>
                  {meta.priorities.map((value) => (
                    <option key={value} value={value}>{value}</option>
                  ))}
                </Select>
                <Select value={queueFilter.category} onChange={(event) => setQueueFilter({ ...queueFilter, category: event.target.value })} aria-label="Category">
                  <option value="">Any category</option>
                  {meta.categories.map((value) => (
                    <option key={value} value={value}>{KIND_LABEL[value] || value}</option>
                  ))}
                </Select>
              </div>
              {queue.summary ? (
                <div className="row wrap tiny dim" style={{ gap: 12 }}>
                  <span>{queue.summary.unassigned} unassigned</span>
                  <span>{queue.summary.urgent} high or urgent</span>
                  <span>{queue.summary.overdue} past due</span>
                  <span>{queue.summary.resolvedToday} resolved today</span>
                </div>
              ) : null}
            </div>

            {queueLoading ? (
              <Loading rows={5} />
            ) : queue.items.length ? (
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Ticket</th>
                      <th>Customer</th>
                      <th>Priority</th>
                      <th>State</th>
                      <th>Owner</th>
                      <th className="align-right">Age</th>
                    </tr>
                  </thead>
                  <tbody>
                    {queue.items.map((row) => (
                      <tr key={row.id} className="clickable" onClick={() => openTicket(row.id)}>
                        <td>
                          <strong style={{ fontSize: '0.79rem' }}>{row.subject}</strong>
                          <div className="tiny dim">
                            {KIND_LABEL[row.category] || row.category}
                            {row.number ? ` · ${row.number}` : ''}
                            {row.notes ? ` · ${row.notes} note${row.notes > 1 ? 's' : ''}` : ''}
                          </div>
                        </td>
                        <td className="tiny">{row.name || row.email || '—'}</td>
                        <td><Badge tone={PRIORITY_TONE[row.priority]}>{row.priority}</Badge></td>
                        <td><Badge tone={TICKET_TONE[row.state]}>{row.state}</Badge></td>
                        <td className="tiny">{row.assignee || 'unassigned'}</td>
                        <td className="align-right tiny">
                          {relativeTime(row.createdAt)}
                          {row.overdue ? <div style={{ color: 'var(--danger)' }}>past due</div> : null}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <Empty icon="inbox" title="Nothing waiting">
                A ticket appears here when someone needs an answer: a complaint, a bill query, a service change or a port.
              </Empty>
            )}
          </Card>
        </div>
      )}

      {ticket ? (
        <Modal title={ticket.ticket.subject} subtitle={`${ticket.ticket.name || ticket.ticket.email || 'no customer'} · ${KIND_LABEL[ticket.ticket.category] || ticket.ticket.category}`} onClose={() => { setTicket(null); setTicketId(''); }} wide>
          <div className="stack">
            <div className="row wrap" style={{ gap: 8 }}>
              <Select label="State" value={ticket.ticket.state} onChange={(event) => moveTicket({ state: event.target.value })}>
                {meta.states.map((value) => (
                  <option key={value} value={value}>{value}</option>
                ))}
              </Select>
              <Select label="Priority" value={ticket.ticket.priority} onChange={(event) => moveTicket({ priority: event.target.value })}>
                {meta.priorities.map((value) => (
                  <option key={value} value={value}>{value}</option>
                ))}
              </Select>
              <Select label="Category" value={ticket.ticket.category} onChange={(event) => moveTicket({ category: event.target.value })}>
                {meta.categories.map((value) => (
                  <option key={value} value={value}>{KIND_LABEL[value] || value}</option>
                ))}
              </Select>
            </div>
            <div className="row wrap" style={{ gap: 8 }}>
              <Input label="Owner" defaultValue={ticket.ticket.assignee} placeholder="who is on it" onBlur={(event) => event.target.value !== ticket.ticket.assignee && moveTicket({ assignee: event.target.value })} />
              <Input label="Due" type="date" defaultValue={(ticket.ticket.dueAt || '').slice(0, 10)} onChange={(event) => moveTicket({ dueAt: event.target.value })} />
            </div>

            <div className="stack" style={{ gap: 8, maxHeight: 320, overflowY: 'auto' }}>
              {ticket.notes.map((row) => (
                <div key={row.id} className="panel" style={{ padding: 10 }}>
                  <div className="tiny dim">
                    {row.actor || 'someone'} · {row.kind === 'system' ? 'change' : row.kind} · {relativeTime(row.at)}
                  </div>
                  <p className="tiny" style={{ marginTop: 4 }}>{row.body}</p>
                </div>
              ))}
            </div>

            <Textarea label="Reply or internal note" rows={3} value={reply} onChange={(event) => setReply(event.target.value)} />
            <div className="row" style={{ gap: 8 }}>
              <Button size="sm" variant="primary" loading={busy === 'reply'} disabled={!reply.trim()} onClick={() => sendReply('note')}>
                Add reply
              </Button>
              <Button size="sm" variant="ghost" loading={busy === 'reply'} disabled={!reply.trim()} onClick={() => sendReply('internal')}>
                Internal only
              </Button>
              <Button size="sm" variant="ghost" style={{ marginLeft: 'auto' }} onClick={() => { if (ticket.ticket.accountId) select(ticket.ticket.accountId); setTicket(null); setTicketId(''); setTab('customers'); }}>
                Open customer
              </Button>
            </div>
          </div>
        </Modal>
      ) : null}

      {newTicket ? (
        <Modal
          title="New ticket"
          subtitle="A complaint, a bill query or a service change — one record, one owner"
          onClose={() => setNewTicket(null)}
          footer={
            <>
              <Button variant="ghost" onClick={() => setNewTicket(null)}>Cancel</Button>
              <Button variant="primary" loading={busy === 'ticket'} disabled={newTicket.subject.trim().length < 3} onClick={createTicket}>
                Open ticket
              </Button>
            </>
          }
        >
          <div className="stack">
            <Input label="Subject" value={newTicket.subject} onChange={(event) => setNewTicket({ ...newTicket, subject: event.target.value })} placeholder="Line rings busy since Tuesday" />
            <Textarea label="What was said" rows={4} value={newTicket.description} onChange={(event) => setNewTicket({ ...newTicket, description: event.target.value })} />
            <div className="row wrap" style={{ gap: 8 }}>
              <Select label="Category" value={newTicket.category} onChange={(event) => setNewTicket({ ...newTicket, category: event.target.value })}>
                {meta.categories.map((value) => (
                  <option key={value} value={value}>{KIND_LABEL[value] || value}</option>
                ))}
              </Select>
              <Select label="Priority" value={newTicket.priority} onChange={(event) => setNewTicket({ ...newTicket, priority: event.target.value })}>
                {meta.priorities.map((value) => (
                  <option key={value} value={value}>{value}</option>
                ))}
              </Select>
            </div>
            <Select label="Customer" value={newTicket.accountId} onChange={(event) => setNewTicket({ ...newTicket, accountId: event.target.value })}>
              <option value="">Not linked to a customer</option>
              {list.items.map((row) => (
                <option key={row.id} value={row.id}>{row.name || row.company || row.email}</option>
              ))}
            </Select>
          </div>
        </Modal>
      ) : null}

      {editOpen && detail ? (
        <Modal
          title="Customer details"
          subtitle="Contact details only — the email is the account identity and is not edited here"
          onClose={() => setEditOpen(false)}
          footer={
            <>
              <Button variant="ghost" onClick={() => setEditOpen(false)}>Cancel</Button>
              <Button variant="primary" loading={busy === 'profile'} onClick={saveProfile}>Save</Button>
            </>
          }
        >
          <div className="stack">
            <div className="grid two">
              <Input label="Name" value={profile.name || ''} onChange={(event) => setProfile({ ...profile, name: event.target.value })} />
              <Input label="Company" value={profile.company || ''} onChange={(event) => setProfile({ ...profile, company: event.target.value })} />
            </div>
            <div className="grid two">
              <Input label="Phone" value={profile.phone || ''} onChange={(event) => setProfile({ ...profile, phone: event.target.value })} />
              <Input label="Website" value={profile.website || ''} onChange={(event) => setProfile({ ...profile, website: event.target.value })} />
            </div>
            <Input label="Address" value={profile.address || ''} onChange={(event) => setProfile({ ...profile, address: event.target.value })} />
            <div className="grid two">
              <Input label="City" value={profile.city || ''} onChange={(event) => setProfile({ ...profile, city: event.target.value })} />
              <Input label="Country" value={profile.country || ''} onChange={(event) => setProfile({ ...profile, country: event.target.value })} />
            </div>
          </div>
        </Modal>
      ) : null}

      {payOpen && detail ? (
        <Modal
          title="Record a payment"
          subtitle="Money that arrived outside the card flow: a transfer, a cheque, a credit or a refund"
          onClose={() => setPayOpen(false)}
          footer={
            <>
              <Button variant="ghost" onClick={() => setPayOpen(false)}>Cancel</Button>
              <Button variant="primary" loading={busy === 'payment'} disabled={!Number(payment.amount)} onClick={recordPayment}>
                Record payment
              </Button>
            </>
          }
        >
          <div className="stack">
            <Select label="Invoice" value={payment.invoiceId} onChange={(event) => {
              const invoice = detail.billing.invoices.find((row) => row.id === event.target.value);
              setPayment({
                ...payment,
                invoiceId: event.target.value,
                amount: invoice && !payment.amount ? (invoice.amountCents / 100).toFixed(2) : payment.amount,
              });
            }}>
              <option value="">Not against a specific invoice</option>
              {detail.billing.invoices.filter((row) => ['open', 'overdue'].includes(row.status)).map((row) => (
                <option key={row.id} value={row.id}>
                  {row.number} · {money(row.amountCents, row.currency)}
                </option>
              ))}
            </Select>
            <div className="grid two">
              <Input label="Amount" type="number" step="0.01" value={payment.amount} onChange={(event) => setPayment({ ...payment, amount: event.target.value })} placeholder="0.00" hint="Negative for a refund" />
              <Select label="Method" value={payment.method} onChange={(event) => setPayment({ ...payment, method: event.target.value })}>
                {meta.paymentMethods.filter((value) => value !== 'stripe').map((value) => (
                  <option key={value} value={value}>{value}</option>
                ))}
              </Select>
            </div>
            <Input label="Reference" value={payment.reference} onChange={(event) => setPayment({ ...payment, reference: event.target.value })} placeholder="cheque 1042, wire 88…" />
            <Input label="Note" value={payment.note} onChange={(event) => setPayment({ ...payment, note: event.target.value })} />
          </div>
        </Modal>
      ) : null}

      {lifecycle ? (
        <Modal
          title={LIFECYCLE_COPY[lifecycle.action].title}
          subtitle={customer ? `${customer.name || customer.company || customer.email} · ${customer.email}` : ''}
          onClose={() => setLifecycle(null)}
          footer={
            <>
              <Button variant="ghost" onClick={() => setLifecycle(null)}>Keep as is</Button>
              <Button
                variant={lifecycle.action === 'remove' ? 'danger' : 'primary'}
                loading={busy === 'lifecycle'}
                onClick={runLifecycle}
              >
                {LIFECYCLE_COPY[lifecycle.action].verb}
              </Button>
            </>
          }
        >
          <div className="stack">
            <p className="muted">{LIFECYCLE_COPY[lifecycle.action].detail}</p>
            {lifecycle.action === 'suspend' ? (
              <Input
                label="Reason"
                value={lifecycle.reason || ''}
                placeholder="non-payment, abuse, customer request…"
                hint="Written to the audit trail beside your name, so the next operator knows why."
                onChange={(event) => setLifecycle({ ...lifecycle, reason: event.target.value })}
              />
            ) : null}
          </div>
        </Modal>
      ) : null}
    </>
  );
}
