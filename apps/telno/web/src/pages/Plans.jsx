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
  Switch,
  Tabs,
  Textarea,
  useToast,
} from '../ui.jsx';

/**
 * Plans, features and subscriptions.
 *
 * This is the one place the commercial catalogue changes. Every edit writes to
 * the rows the public subscribe page reads, so there is no second copy to keep
 * in step — and a change is pushed to the subscriber system of record when one
 * is configured.
 */

const money = (cents, currency = 'USD') =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency }).format((cents || 0) / 100);

const STATUS_TONE = { active: 'success', trialing: 'success', past_due: 'warning', incomplete: 'warning', canceled: 'danger' };

const BLANK_PLAN = {
  name: '',
  slug: '',
  tagline: '',
  description: '',
  priceCents: 2900,
  currency: 'USD',
  interval: 'month',
  seats: 5,
  includedMinutes: 1000,
  active: true,
  sortOrder: 100,
  features: [],
};

export default function Plans() {
  const toast = useToast();
  const [tab, setTab] = useState('plans');
  const [loading, setLoading] = useState(true);
  const [data, setData] = useState({ plans: [], features: [], subscriptions: [] });
  const [editing, setEditing] = useState(null);
  const [planForm, setPlanForm] = useState(BLANK_PLAN);
  const [featureForm, setFeatureForm] = useState(null);
  const [subForm, setSubForm] = useState(null);
  const [busy, setBusy] = useState('');

  const load = async () => {
    try {
      setData(await api.get('/plans'));
    } catch (err) {
      toast.error('Could not load plans', err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const openPlan = (plan) => {
    setEditing(plan || 'new');
    setPlanForm(
      plan
        ? {
            name: plan.name,
            slug: plan.slug,
            tagline: plan.tagline,
            description: plan.description,
            priceCents: plan.priceCents,
            currency: plan.currency,
            interval: plan.interval,
            seats: plan.seats,
            includedMinutes: plan.includedMinutes,
            active: plan.active,
            sortOrder: plan.sortOrder,
            features: plan.features.map((feature) => feature.key),
          }
        : BLANK_PLAN
    );
  };

  const savePlan = async () => {
    setBusy('plan');
    try {
      const payload = {
        name: planForm.name,
        slug: planForm.slug || undefined,
        tagline: planForm.tagline,
        description: planForm.description,
        priceCents: Number(planForm.priceCents),
        currency: planForm.currency,
        interval: planForm.interval,
        seats: Number(planForm.seats),
        includedMinutes: Number(planForm.includedMinutes),
        active: planForm.active,
        sortOrder: Number(planForm.sortOrder),
        features: planForm.features,
      };
      const result =
        editing === 'new' ? await api.post('/plans', payload) : await api.patch(`/plans/${editing.id}`, payload);
      setEditing(null);
      await load();
      const sync = result.plan?.magnate;
      toast.success(editing === 'new' ? 'Plan created' : 'Plan saved',
        sync?.ok ? 'Mirrored to the subscriber system of record.' : 'Live on the public page now.');
    } catch (err) {
      toast.error('Could not save the plan', err.message);
    } finally {
      setBusy('');
    }
  };

  const retirePlan = async (plan) => {
    if (!window.confirm(`Retire ${plan.name}? It stops appearing on the subscribe page; existing customers keep it.`)) return;
    setBusy(plan.id);
    try {
      const result = await api.del(`/plans/${plan.id}`);
      await load();
      toast.success(
        `${plan.name} retired`,
        result.liveSubscriptions ? `${result.liveSubscriptions} live subscription(s) keep the plan.` : 'No live subscriptions.'
      );
    } catch (err) {
      toast.error('Could not retire the plan', err.message);
    } finally {
      setBusy('');
    }
  };

  const syncPlan = async (plan) => {
    setBusy(`sync-${plan.id}`);
    try {
      const result = await api.post(`/plans/${plan.id}/sync`, {});
      if (result.magnate.ok) toast.success('Mirrored', 'The subscriber system has the new catalogue.');
      else toast.error('Not mirrored', result.magnate.error === 'magnate_not_configured'
        ? 'Add MAGNATE_WEBHOOK_URL in Settings → Vault to mirror automatically.'
        : result.magnate.error);
    } catch (err) {
      toast.error('Could not sync', err.message);
    } finally {
      setBusy('');
    }
  };

  const saveFeature = async () => {
    setBusy('feature');
    try {
      if (featureForm.editing) await api.patch(`/features/${featureForm.key}`, featureForm);
      else await api.post('/features', featureForm);
      setFeatureForm(null);
      await load();
      toast.success('Feature saved');
    } catch (err) {
      toast.error('Could not save the feature', err.message);
    } finally {
      setBusy('');
    }
  };

  const removeFeature = async (feature) => {
    if (!window.confirm(`Delete ${feature.label}? It is removed from every plan that includes it.`)) return;
    setBusy(feature.key);
    try {
      await api.del(`/features/${feature.key}`);
      await load();
      toast.success(`${feature.label} removed from every plan`);
    } catch (err) {
      toast.error('Could not delete the feature', err.message);
    } finally {
      setBusy('');
    }
  };

  /**
   * Two ways in: an account that already exists, or a customer being onboarded
   * by hand — the one who pays by transfer and never sees a checkout page.
   */
  const createSubscription = async () => {
    setBusy('sub');
    try {
      if (subForm.mode === 'new') {
        await api.post('/customers', {
          email: subForm.email,
          name: subForm.name,
          password: subForm.password,
          planId: subForm.planId,
          status: subForm.status,
        });
      } else {
        await api.post('/subscriptions', {
          email: subForm.email,
          planId: subForm.planId,
          status: subForm.status,
        });
      }
      setSubForm(null);
      await load();
      toast.success(
        subForm.mode === 'new' ? 'Customer created' : 'Subscription added',
        'They can sign in to the portal now.'
      );
    } catch (err) {
      toast.error('Could not add the subscription', err.message);
    } finally {
      setBusy('');
    }
  };

  const setStatus = async (subscription, status) => {
    setBusy(subscription.id);
    try {
      await api.patch(`/subscriptions/${subscription.id}`, { status });
      await load();
      toast.success(`${subscription.email} is ${status.replace('_', ' ')}`);
    } catch (err) {
      toast.error('Could not change the subscription', err.message);
    } finally {
      setBusy('');
    }
  };

  const changePlan = async (subscription, planId) => {
    setBusy(subscription.id);
    try {
      await api.patch(`/subscriptions/${subscription.id}`, { planId });
      await load();
      toast.success('Plan changed', 'The subscription keeps a snapshot of what was sold.');
    } catch (err) {
      toast.error('Could not change the plan', err.message);
    } finally {
      setBusy('');
    }
  };

  if (loading) {
    return (
      <Card>
        <Loading rows={4} />
      </Card>
    );
  }

  const active = data.subscriptions.filter((row) => row.status === 'active' || row.status === 'trialing');
  const monthly = active.reduce(
    (total, row) => total + (row.interval === 'year' ? row.priceCents / 12 : row.priceCents),
    0
  );

  return (
    <>
      <PageHeader
        title="Plans and subscriptions"
        subtitle="What the subscribe page sells, what each plan includes, and who is paying"
        actions={
          <div className="row" style={{ gap: 8 }}>
            <Button variant="ghost" icon="external" onClick={() => window.open(data.subscribeUrl, '_blank', 'noreferrer')}>
              Public page
            </Button>
            <Button variant="primary" icon="plus" onClick={() => openPlan(null)}>
              New plan
            </Button>
          </div>
        }
      />

      <div className="grid stats">
        <Stat label="Live subscriptions" value={active.length} foot={`${data.subscriptions.length} ever`} />
        <Stat label="Monthly recurring" value={money(monthly, 'USD')} foot="From active subscriptions" />
        <Stat label="Plans" value={data.plans.filter((plan) => plan.active).length} foot={`${data.plans.length} total`} />
        <Stat label="Features" value={data.features.length} foot={data.magnate.configured ? 'Magnate mirrored' : 'No mirror configured'} />
      </div>

      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          { value: 'plans', label: 'Plans' },
          { value: 'features', label: 'Features' },
          { value: 'subscriptions', label: 'Subscriptions' },
        ]}
      />

      {tab === 'plans' ? (
        <div className="grid three" style={{ marginTop: 16 }}>
          {data.plans.map((plan) => (
            <Card
              key={plan.id}
              title={plan.name}
              subtitle={plan.tagline || plan.slug}
              actions={<Badge tone={plan.active ? 'success' : 'neutral'}>{plan.active ? 'On sale' : 'Retired'}</Badge>}
            >
              <div className="stack">
                <div className="row" style={{ gap: 8, alignItems: 'baseline' }}>
                  <strong style={{ fontSize: 24 }}>{money(plan.priceCents, plan.currency)}</strong>
                  <span className="tiny dim">/{plan.interval}</span>
                  {plan.isDefault ? <Badge tone="neutral">Default</Badge> : null}
                </div>
                <div className="row wrap" style={{ gap: 6 }}>
                  <span className="tiny dim">{plan.seats} seats</span>
                  <span className="tiny dim">·</span>
                  <span className="tiny dim">{plan.includedMinutes.toLocaleString()} minutes</span>
                </div>
                <div className="row wrap" style={{ gap: 4 }}>
                  {plan.features.length ? (
                    plan.features.map((feature) => (
                      <span key={feature.key} className="badge neutral" title={feature.description}>
                        {feature.label}
                      </span>
                    ))
                  ) : (
                    <span className="tiny dim">No features yet</span>
                  )}
                </div>
                <p className="tiny muted" style={{ margin: 0 }}>{plan.description}</p>
                <div className="row wrap" style={{ gap: 6 }}>
                  <Button size="sm" icon="edit" onClick={() => openPlan(plan)}>
                    Edit
                  </Button>
                  <Button size="sm" variant="ghost" icon="refresh" loading={busy === `sync-${plan.id}`} onClick={() => syncPlan(plan)}>
                    Mirror
                  </Button>
                  {plan.active ? (
                    <Button size="sm" variant="ghost" icon="trash" loading={busy === plan.id} onClick={() => retirePlan(plan)}>
                      Retire
                    </Button>
                  ) : (
                    <Button size="sm" variant="ghost" icon="check" loading={busy === plan.id} onClick={() => api.patch(`/plans/${plan.id}`, { active: true }).then(load)}>
                      Restore
                    </Button>
                  )}
                </div>
              </div>
            </Card>
          ))}
          {!data.plans.length ? (
            <Card>
              <Empty icon="card" title="No plans yet" action={<Button variant="primary" onClick={() => openPlan(null)}>Create one</Button>}>
                The public subscribe page has nothing to sell until there is a plan.
              </Empty>
            </Card>
          ) : null}
        </div>
      ) : null}

      {tab === 'features' ? (
        <Card
          title="Feature catalogue"
          subtitle="Every capability a plan can include — one list, read by the admin, the subscribe page and the entitlement check"
          actions={<Button size="sm" icon="plus" onClick={() => setFeatureForm({ key: '', label: '', description: '', category: 'calling', addon: false, sortOrder: 100, active: true })}>New feature</Button>}
          bodyClass=""
        >
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Feature</th>
                  <th>Key</th>
                  <th>Category</th>
                  <th>Plans</th>
                  <th>Add-on</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {data.features.map((feature) => (
                  <tr key={feature.key}>
                    <td>
                      <div className="stack" style={{ gap: 2 }}>
                        <strong>{feature.label}</strong>
                        <span className="tiny dim">{feature.description}</span>
                      </div>
                    </td>
                    <td className="mono tiny">{feature.key}</td>
                    <td className="tiny">{feature.category}</td>
                    <td className="tiny">{feature.plans?.length || 0}</td>
                    <td>{feature.addon ? <Badge tone="warning">Add-on</Badge> : <span className="dim tiny">Included</span>}</td>
                    <td>
                      <div className="row" style={{ gap: 4 }}>
                        <Button
                          size="sm"
                          variant="ghost"
                          icon="edit"
                          onClick={() => setFeatureForm({ ...feature, editing: true })}
                          aria-label={`Edit ${feature.label}`}
                        />
                        <Button
                          size="sm"
                          variant="ghost"
                          icon="trash"
                          loading={busy === feature.key}
                          onClick={() => removeFeature(feature)}
                          aria-label={`Delete ${feature.label}`}
                        />
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      ) : null}

      {tab === 'subscriptions' ? (
        <Card
          title="Subscriptions"
          subtitle="Bought on the subscribe page, or added here without a card"
          actions={
            <Button
              size="sm"
              icon="plus"
              onClick={() =>
                setSubForm({ mode: 'existing', email: '', name: '', password: '', planId: data.plans[0]?.id || '', status: 'active' })
              }
            >
              Add
            </Button>
          }
        >
          {data.subscriptions.length ? (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Customer</th>
                    <th>Plan</th>
                    <th>Status</th>
                    <th>Renews</th>
                    <th>Started</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {data.subscriptions.map((row) => (
                    <tr key={row.id}>
                      <td>
                        <div className="stack" style={{ gap: 2 }}>
                          <span>{row.accountName || row.email}</span>
                          <span className="tiny dim">{row.email}</span>
                        </div>
                      </td>
                      <td>
                        <Select
                          aria-label={`Plan for ${row.email}`}
                          value={row.planId}
                          onChange={(event) => changePlan(row, event.target.value)}
                          style={{ minWidth: 130 }}
                        >
                          {data.plans.map((plan) => (
                            <option key={plan.id} value={plan.id}>
                              {plan.name}
                            </option>
                          ))}
                        </Select>
                      </td>
                      <td>
                        <Badge tone={STATUS_TONE[row.status] || 'neutral'}>{row.status.replace('_', ' ')}</Badge>
                      </td>
                      <td className="tiny">
                        {row.currentPeriodEnd ? new Date(row.currentPeriodEnd).toLocaleDateString('en-US') : <span className="dim">—</span>}
                      </td>
                      <td className="tiny dim">{relativeTime(row.createdAt)}</td>
                      <td>
                        <div className="row" style={{ gap: 4 }}>
                          {row.status !== 'active' ? (
                            <Button size="sm" variant="ghost" icon="check" loading={busy === row.id} onClick={() => setStatus(row, 'active')}>
                              Activate
                            </Button>
                          ) : (
                            <Button size="sm" variant="ghost" icon="x" loading={busy === row.id} onClick={() => setStatus(row, 'canceled')}>
                              Cancel
                            </Button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <Empty icon="card" title="No subscriptions yet">
              Customers who buy on the subscribe page appear here as soon as Stripe confirms the payment.
            </Empty>
          )}
        </Card>
      ) : null}

      {editing ? (
        <Modal
          title={editing === 'new' ? 'New plan' : `Edit ${editing.name}`}
          subtitle="Editing a plan changes the public page immediately. Existing subscriptions keep the price they were sold."
          onClose={() => setEditing(null)}
          wide
          footer={
            <>
              <Button variant="ghost" onClick={() => setEditing(null)}>
                Cancel
              </Button>
              <Button variant="primary" loading={busy === 'plan'} disabled={!planForm.name.trim()} onClick={savePlan}>
                {editing === 'new' ? 'Create plan' : 'Save plan'}
              </Button>
            </>
          }
        >
          <div className="stack">
            <div className="grid two">
              <Input label="Name" value={planForm.name} onChange={(event) => setPlanForm({ ...planForm, name: event.target.value })} />
              <Input
                label="Slug"
                value={planForm.slug}
                onChange={(event) => setPlanForm({ ...planForm, slug: event.target.value })}
                hint="Used in the plan URL. Left blank, it is made from the name."
              />
            </div>
            <Input label="Tagline" value={planForm.tagline} onChange={(event) => setPlanForm({ ...planForm, tagline: event.target.value })} />
            <Textarea
              label="Description"
              rows={3}
              value={planForm.description}
              onChange={(event) => setPlanForm({ ...planForm, description: event.target.value })}
            />
            <div className="grid three">
              <Input
                label="Price (cents)"
                type="number"
                min="0"
                value={planForm.priceCents}
                onChange={(event) => setPlanForm({ ...planForm, priceCents: event.target.value })}
                hint={money(Number(planForm.priceCents) || 0, planForm.currency)}
              />
              <Select label="Currency" value={planForm.currency} onChange={(event) => setPlanForm({ ...planForm, currency: event.target.value })}>
                <option value="USD">USD</option>
                <option value="CAD">CAD</option>
                <option value="EUR">EUR</option>
                <option value="GBP">GBP</option>
              </Select>
              <Select label="Interval" value={planForm.interval} onChange={(event) => setPlanForm({ ...planForm, interval: event.target.value })}>
                <option value="month">Monthly</option>
                <option value="year">Yearly</option>
              </Select>
            </div>
            <div className="grid three">
              <Input
                label="Seats"
                type="number"
                min="1"
                value={planForm.seats}
                onChange={(event) => setPlanForm({ ...planForm, seats: event.target.value })}
              />
              <Input
                label="Included minutes"
                type="number"
                min="0"
                value={planForm.includedMinutes}
                onChange={(event) => setPlanForm({ ...planForm, includedMinutes: event.target.value })}
              />
              <Input
                label="Sort order"
                type="number"
                value={planForm.sortOrder}
                onChange={(event) => setPlanForm({ ...planForm, sortOrder: event.target.value })}
              />
            </div>
            <Switch checked={planForm.active} onChange={(value) => setPlanForm({ ...planForm, active: value })} label="On sale" />
            <div className="stack" style={{ gap: 6 }}>
              <span className="tiny dim">Included features</span>
              <div className="row wrap" style={{ gap: 12 }}>
                {data.features.map((feature) => (
                  <label key={feature.key} className="row" style={{ gap: 6, cursor: 'pointer' }}>
                    <input
                      type="checkbox"
                      checked={planForm.features.includes(feature.key)}
                      onChange={(event) =>
                        setPlanForm({
                          ...planForm,
                          features: event.target.checked
                            ? [...planForm.features, feature.key]
                            : planForm.features.filter((key) => key !== feature.key),
                        })
                      }
                    />
                    <span className="tiny">{feature.label}</span>
                  </label>
                ))}
              </div>
              <p className="tiny dim" style={{ margin: 0 }}>
                Ticking a box adds the feature to the plan, the public page and what a subscriber is entitled to — one edit, not three.
              </p>
            </div>
          </div>
        </Modal>
      ) : null}

      {featureForm ? (
        <Modal
          title={featureForm.editing ? `Edit ${featureForm.label}` : 'New feature'}
          onClose={() => setFeatureForm(null)}
          footer={
            <>
              <Button variant="ghost" onClick={() => setFeatureForm(null)}>
                Cancel
              </Button>
              <Button variant="primary" loading={busy === 'feature'} disabled={!featureForm.label.trim()} onClick={saveFeature}>
                Save
              </Button>
            </>
          }
        >
          <div className="stack">
            <Input
              label="Key"
              value={featureForm.key}
              disabled={!!featureForm.editing}
              onChange={(event) => setFeatureForm({ ...featureForm, key: event.target.value })}
              hint="Stable identifier, e.g. video-calling."
            />
            <Input label="Label" value={featureForm.label} onChange={(event) => setFeatureForm({ ...featureForm, label: event.target.value })} />
            <Textarea
              label="Description"
              rows={2}
              value={featureForm.description}
              onChange={(event) => setFeatureForm({ ...featureForm, description: event.target.value })}
            />
            <div className="grid two">
              <Input
                label="Category"
                value={featureForm.category}
                onChange={(event) => setFeatureForm({ ...featureForm, category: event.target.value })}
              />
              <Input
                label="Sort order"
                type="number"
                value={featureForm.sortOrder}
                onChange={(event) => setFeatureForm({ ...featureForm, sortOrder: Number(event.target.value) })}
              />
            </div>
            <Switch checked={featureForm.addon} onChange={(value) => setFeatureForm({ ...featureForm, addon: value })} label="Sold as an add-on" />
          </div>
        </Modal>
      ) : null}

      {subForm ? (
        <Modal
          title={subForm.mode === 'new' ? 'New customer' : 'Add a subscription'}
          subtitle="For a customer who paid by transfer, or a comp. No card is taken here."
          onClose={() => setSubForm(null)}
          footer={
            <>
              <Button variant="ghost" onClick={() => setSubForm(null)}>
                Cancel
              </Button>
              <Button
                variant="primary"
                loading={busy === 'sub'}
                disabled={
                  !subForm.email.trim() ||
                  (subForm.mode === 'new' && (!subForm.name.trim() || subForm.password.length < 10))
                }
                onClick={createSubscription}
              >
                {subForm.mode === 'new' ? 'Create customer' : 'Add subscription'}
              </Button>
            </>
          }
        >
          <div className="stack">
            <div className="row wrap" style={{ gap: 12 }}>
              {[
                ['existing', 'Existing account'],
                ['new', 'New customer'],
              ].map(([value, label]) => (
                <label key={value} className="row" style={{ gap: 6, cursor: 'pointer' }}>
                  <input
                    type="radio"
                    name="sub-mode"
                    checked={subForm.mode === value}
                    onChange={() => setSubForm({ ...subForm, mode: value })}
                  />
                  <span className="tiny">{label}</span>
                </label>
              ))}
            </div>
            <Input
              label="Customer email"
              type="email"
              value={subForm.email}
              onChange={(event) => setSubForm({ ...subForm, email: event.target.value })}
              hint={
                subForm.mode === 'new'
                  ? 'This is their sign-in and where notices go.'
                  : 'The account has to exist already — customers create one on the subscribe page.'
              }
            />
            {subForm.mode === 'new' ? (
              <div className="grid two">
                <Input
                  label="Name"
                  value={subForm.name}
                  onChange={(event) => setSubForm({ ...subForm, name: event.target.value })}
                />
                <Input
                  label="Temporary password"
                  type="password"
                  autoComplete="new-password"
                  value={subForm.password}
                  onChange={(event) => setSubForm({ ...subForm, password: event.target.value })}
                  hint="At least 10 characters; they can change it after signing in."
                />
              </div>
            ) : null}
            <Select label="Plan" value={subForm.planId} onChange={(event) => setSubForm({ ...subForm, planId: event.target.value })}>
              {data.plans.map((plan) => (
                <option key={plan.id} value={plan.id}>
                  {plan.name} · {money(plan.priceCents, plan.currency)}/{plan.interval}
                </option>
              ))}
            </Select>
            <Select label="Status" value={subForm.status} onChange={(event) => setSubForm({ ...subForm, status: event.target.value })}>
              <option value="active">Active</option>
              <option value="trialing">Trialing</option>
              <option value="past_due">Past due</option>
            </Select>
          </div>
        </Modal>
      ) : null}
    </>
  );
}
