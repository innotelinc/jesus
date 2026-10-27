import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { Badge, Button, Icon, Input, Loading, useToast } from '../ui.jsx';
import { useAuth } from '../auth.jsx';

/**
 * The required first login.
 *
 * Five steps, in order, and no way past them: the server refuses every other
 * route until they are answered, so this is a door rather than a suggestion. It
 * says what each step is *for* — a wizard that asks for a phone number without
 * saying that is where outage notices go is a form, and forms get clicked
 * through.
 *
 * The state always comes from the server. Each answer returns the whole state
 * again, so the ticks, the "next step" and this screen cannot disagree with what
 * the platform actually recorded.
 */

export default function Onboarding() {
  const toast = useToast();
  const { refresh } = useAuth();
  const [state, setState] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');
  const [accepted, setAccepted] = useState(false);
  const [profile, setProfile] = useState(null);
  const [code, setCode] = useState({ email: '', phone: '' });
  const [phone, setPhone] = useState('');
  const [sent, setSent] = useState({ email: '', phone: '' });
  const [line, setLine] = useState({ extension: '101', displayName: '', number: '' });
  const [buy, setBuy] = useState({ query: '', region: '', items: [] });

  const load = async () => {
    const data = await api.get('/onboarding');
    setState(data);
    setProfile((current) => ({
      name: current?.name ?? data.profile.name ?? '',
      company: current?.company ?? data.profile.company ?? '',
      address: current?.address ?? data.profile.address ?? '',
      city: current?.city ?? data.profile.city ?? '',
      country: current?.country ?? data.profile.country ?? '',
      website: current?.website ?? data.profile.website ?? '',
      directoryOptIn: current?.directoryOptIn ?? data.profile.directoryOptIn ?? null,
    }));
    setPhone((current) => current || data.phone.number || '');
    setLine((current) => ({ ...current, displayName: current.displayName || data.profile.name || '' }));
    return data;
  };

  useEffect(() => {
    load()
      .catch((err) => toast.error('Could not read your setup steps', err.message))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const run = async (key, work, done) => {
    setBusy(key);
    try {
      const result = await work();
      if (done) toast.success(done);
      await load();
      return result;
    } catch (err) {
      toast.error('That step did not complete', err.message);
      return null;
    } finally {
      setBusy('');
    }
  };

  /** Put a number on this account's line, creating the line if there is none. */
  const ensureLine = async (number) =>
    state.line.lines > 0
      ? api.post('/setup/number', { extension: line.extension, number })
      : api.post('/setup/line', { extension: line.extension, displayName: line.displayName, number });

  const searchNumbers = async () => {
    setBusy('buy-search');
    try {
      const query = new URLSearchParams({ country: 'US', q: buy.query.trim(), limit: '25' });
      if (buy.region.trim()) query.set('region', buy.region.trim());
      const result = await api.get(`/provider/voipms/search?${query.toString()}`);
      setBuy((current) => ({ ...current, items: result.items || [] }));
      if (!result.items?.length) {
        toast.info('No numbers matched', 'Try another area code, or the rate center beside it.');
      }
    } catch (err) {
      toast.error('The carrier search did not answer', err.message);
    } finally {
      setBusy('');
    }
  };

  /**
   * Rent a number and put it on the line in the same breath. A DID bought and
   * not attached is money spent on a number nobody can dial.
   */
  const buyNumber = async (did) => {
    setBusy(`buy-${did}`);
    try {
      const ordered = await api.post('/provider/voipms/numbers', { dids: [did] });
      if (!ordered.ordered?.length) {
        throw new Error(ordered.failed?.[0]?.error || 'The carrier did not sell that number');
      }
      await ensureLine(did);
      toast.success('Number rented', `${did} is on your line and billed monthly.`);
      setBuy((current) => ({ ...current, items: [] }));
      await load();
    } catch (err) {
      toast.error('That number could not be rented', err.message);
    } finally {
      setBusy('');
    }
  };

  const askForCode = async (channel) => {
    const result = await run(
      `${channel}-send`,
      () =>
        channel === 'email'
          ? api.post('/onboarding/email/code', {})
          : api.post('/onboarding/phone/code', { phone }),
      'Code sent'
    );
    if (!result) return;
    setSent({ ...sent, [channel]: result.target });
    // Outside production the server hands the code back so the flow is testable
    // without a mail or SMS provider; typing it for the operator is the point.
    if (result.devCode) {
      setCode((current) => ({ ...current, [channel]: result.devCode }));
      toast.info('Development code filled in for you', result.devCode);
    }
  };

  if (loading || !state || !profile) {
    return (
      <div className="public-shell">
        <Loading rows={4} />
      </div>
    );
  }

  const remaining = state.steps.filter((step) => !step.done).length;

  return (
    <div className="public-shell">
      <section className="public-hero" style={{ paddingBottom: 2 }}>
        <Badge tone="neutral" dot="live">
          {remaining === 1 ? '1 step left' : `${remaining} steps left`}
        </Badge>
        <h1>Let&apos;s get your account set up</h1>
        <p className="muted">
          This happens once. Until it is finished the console stays closed, because each answer is something the
          platform needs in order to bill you correctly, reach you about your service, and put a working phone in front
          of you.
        </p>
      </section>

      <div className="card stack" style={{ maxWidth: 780, width: '100%', margin: '0 auto' }}>
        <ol className="stack" style={{ listStyle: 'none', padding: 0, margin: 0, gap: 10 }}>
          {state.steps.map((step, index) => {
            const active = step.id === state.next;
            return (
              <li
                key={step.id}
                style={{
                  display: 'flex',
                  gap: 12,
                  alignItems: 'flex-start',
                  padding: '12px 14px',
                  borderRadius: 'var(--radius)',
                  border: `1px solid ${active ? 'rgba(111, 102, 255, 0.5)' : 'var(--border)'}`,
                  background: active ? 'rgba(111, 102, 255, 0.07)' : 'transparent',
                  opacity: step.done || active ? 1 : 0.6,
                }}
              >
                <span className={step.done ? 'brand-mark' : 'brand-mark ghost'} aria-hidden="true" style={{ flex: 'none' }}>
                  {step.done ? <Icon name="check" size={15} /> : <span className="mono tiny">{index + 1}</span>}
                </span>

                <div style={{ minWidth: 0, flex: 1 }}>
                  <div className="row wrap" style={{ gap: 8, alignItems: 'center' }}>
                    <strong style={{ fontSize: '0.9375rem' }}>{step.title}</strong>
                    {step.done ? <Badge tone="success">Done</Badge> : null}
                    {active ? <Badge tone="info">Now</Badge> : null}
                  </div>
                  <p className="tiny dim" style={{ margin: '3px 0 0' }}>
                    {step.detail}
                  </p>

                  {active && step.id === 'terms' ? (
                    <div className="stack" style={{ marginTop: 12, gap: 10 }}>
                      <div
                        className="tiny"
                        style={{
                          maxHeight: 240,
                          overflowY: 'auto',
                          padding: '12px 14px',
                          border: '1px solid var(--border)',
                          borderRadius: 'var(--radius)',
                          background: 'rgba(0, 0, 0, 0.2)',
                          lineHeight: 1.65,
                        }}
                      >
                        {state.termsText.map((paragraph) => (
                          <p key={paragraph.slice(0, 24)} style={{ margin: '0 0 10px' }}>
                            {paragraph}
                          </p>
                        ))}
                        <p className="dim" style={{ margin: 0 }}>
                          Version {state.terms.version}. Accepting is recorded on your account with the time and the
                          address you are signing in from.
                        </p>
                      </div>
                      <label className="row tiny" style={{ gap: 8, alignItems: 'flex-start' }}>
                        <input
                          type="checkbox"
                          checked={accepted}
                          onChange={(event) => setAccepted(event.target.checked)}
                          style={{ marginTop: 3 }}
                        />
                        <span>
                          I have read and agree to the terms of service, and I am authorized to bind this account to
                          them.
                        </span>
                      </label>
                      <div className="row">
                        <Button
                          variant="primary"
                          disabled={!accepted}
                          loading={busy === 'terms'}
                          onClick={() => run('terms', () => api.post('/onboarding/terms', { accept: true }), 'Terms accepted')}
                        >
                          Accept and continue
                        </Button>
                        <a className="btn ghost" href="/terms" target="_blank" rel="noreferrer">
                          Open in a new tab
                        </a>
                      </div>
                    </div>
                  ) : null}

                  {active && step.id === 'profile' ? (
                    <div className="stack" style={{ marginTop: 12, gap: 12 }}>
                      <div className="grid two" style={{ gap: 12 }}>
                        <Input
                          label="Name on the account"
                          value={profile.name}
                          onChange={(event) => setProfile({ ...profile, name: event.target.value })}
                        />
                        <Input
                          label="Company (optional)"
                          value={profile.company}
                          onChange={(event) => setProfile({ ...profile, company: event.target.value })}
                        />
                        <Input
                          label="Billing address"
                          placeholder="123 Main St, Apt 4"
                          value={profile.address}
                          onChange={(event) => setProfile({ ...profile, address: event.target.value })}
                        />
                        <Input
                          label="City"
                          value={profile.city}
                          onChange={(event) => setProfile({ ...profile, city: event.target.value })}
                        />
                        <Input
                          label="State or country code"
                          hint="Two letters, for example CA"
                          value={profile.country}
                          onChange={(event) => setProfile({ ...profile, country: event.target.value })}
                        />
                        <Input
                          label="Website (optional)"
                          value={profile.website}
                          onChange={(event) => setProfile({ ...profile, website: event.target.value })}
                        />
                      </div>
                      <div className="stack" style={{ gap: 6 }}>
                        <span className="tiny dim">
                          May your numbers be listed in the public directory? There is no default: a number is only
                          published if you say yes, and you can change it later.
                        </span>
                        <div className="row wrap" style={{ gap: 16 }}>
                          <label className="row tiny" style={{ gap: 8 }}>
                            <input
                              type="radio"
                              name="directoryOptIn"
                              checked={profile.directoryOptIn === true}
                              onChange={() => setProfile({ ...profile, directoryOptIn: true })}
                            />
                            <span>List my numbers publicly</span>
                          </label>
                          <label className="row tiny" style={{ gap: 8 }}>
                            <input
                              type="radio"
                              name="directoryOptIn"
                              checked={profile.directoryOptIn === false}
                              onChange={() => setProfile({ ...profile, directoryOptIn: false })}
                            />
                            <span>Keep them private</span>
                          </label>
                        </div>
                      </div>
                      <div className="row">
                        <Button
                          variant="primary"
                          loading={busy === 'profile'}
                          disabled={!profile.name.trim() || profile.directoryOptIn === null}
                          onClick={() =>
                            run('profile', () => api.post('/onboarding/profile', profile), 'Details confirmed')
                          }
                        >
                          Save and continue
                        </Button>
                      </div>
                    </div>
                  ) : null}

                  {active && step.id === 'email' ? (
                    <div className="stack" style={{ marginTop: 12, gap: 12 }}>
                      <div className="row wrap" style={{ gap: 10, alignItems: 'flex-end' }}>
                        <Input
                          label="Code from the email"
                          inputMode="numeric"
                          placeholder="000000"
                          className="mono"
                          value={code.email}
                          onChange={(event) =>
                            setCode({ ...code, email: event.target.value.replace(/\D/g, '').slice(0, 6) })
                          }
                          hint={sent.email ? `Sent to ${sent.email}` : `We send it to ${state.email.address}`}
                        />
                        <Button loading={busy === 'email-send'} onClick={() => askForCode('email')}>
                          {sent.email ? 'Send it again' : 'Send the code'}
                        </Button>
                        <Button
                          variant="primary"
                          disabled={code.email.length !== 6}
                          loading={busy === 'email-verify'}
                          onClick={() =>
                            run('email-verify', () => api.post('/onboarding/email/verify', { code: code.email }), 'Email verified')
                          }
                        >
                          Verify
                        </Button>
                      </div>
                      <p className="tiny dim" style={{ margin: 0 }}>
                        This is where your invoices and service notices are sent, so it has to be an address you can
                        actually open.
                        {state.channel?.codes?.email
                          ? ' This install sends mail through its own log, so the code is put in the box for you when you ask for it.'
                          : ''}
                      </p>
                    </div>
                  ) : null}

                  {active && step.id === 'phone' ? (
                    <div className="stack" style={{ marginTop: 12, gap: 12 }}>
                      <div className="row wrap" style={{ gap: 10, alignItems: 'flex-end' }}>
                        <Input
                          label="Mobile number"
                          inputMode="tel"
                          placeholder="+1 555 010 1234"
                          className="mono"
                          value={phone}
                          onChange={(event) => setPhone(event.target.value)}
                          hint="A code arrives here by text message."
                        />
                        <Button loading={busy === 'phone-send'} disabled={phone.trim().length < 7} onClick={() => askForCode('phone')}>
                          {sent.phone ? 'Send it again' : 'Send the code'}
                        </Button>
                      </div>
                      <div className="row wrap" style={{ gap: 10, alignItems: 'flex-end' }}>
                        <Input
                          label="Code from the text"
                          inputMode="numeric"
                          placeholder="000000"
                          className="mono"
                          value={code.phone}
                          onChange={(event) => setCode({ ...code, phone: event.target.value.replace(/\D/g, '').slice(0, 6) })}
                          hint={sent.phone ? `Sent to ${sent.phone}` : 'Ask for a code first'}
                        />
                        <Button
                          variant="primary"
                          disabled={code.phone.length !== 6}
                          loading={busy === 'phone-verify'}
                          onClick={() =>
                            run('phone-verify', () => api.post('/onboarding/phone/verify', { code: code.phone }), 'Phone verified')
                          }
                        >
                          Verify
                        </Button>
                      </div>
                      <p className="tiny dim" style={{ margin: 0 }}>
                        Outage and billing notices go to the number verified here. It is not the number you call from —
                        that comes next.
                        {state.channel?.codes?.sms
                          ? ' Text delivery is not configured on this install, so the code is put in the box for you.'
                          : ''}
                      </p>
                    </div>
                  ) : null}

                  {active && step.id === 'line' ? (
                    <div className="stack" style={{ marginTop: 12, gap: 12 }}>
                      <div className="grid two" style={{ gap: 12 }}>
                        <Input
                          label="Extension"
                          inputMode="numeric"
                          hint="The number you dial on the switch. 101 is the usual first one."
                          value={line.extension}
                          onChange={(event) =>
                            setLine({ ...line, extension: event.target.value.replace(/\D/g, '').slice(0, 6) })
                          }
                        />
                        <Input
                          label="What to call this line"
                          placeholder="Front desk"
                          value={line.displayName}
                          onChange={(event) => setLine({ ...line, displayName: event.target.value })}
                        />
                      </div>
                      <Input
                        label="Phone number for this line"
                        inputMode="tel"
                        placeholder="+1 555 010 199"
                        className="mono"
                        value={line.number}
                        onChange={(event) => setLine({ ...line, number: event.target.value })}
                        hint="A number you already own, in international form. To buy one from the carrier instead, connect VoIP.ms in Settings and use Numbers."
                      />
                      <div className="row">
                        <Button
                          variant="primary"
                          loading={busy === 'line'}
                          disabled={!line.extension || line.number.trim().length < 7}
                          onClick={() => run('line', () => ensureLine(line.number), 'Line created')}
                        >
                          {state.line.lines > 0 ? 'Attach this number' : 'Create my line'}
                        </Button>
                      </div>
                      <p className="tiny dim" style={{ margin: 0 }}>
                        {state.line.lines > 0 && state.line.numbers > 0
                          ? `${state.line.lines} line(s) and ${state.line.numbers} number(s) are on this account.`
                          : 'Both are needed: the extension is what registers and rings, the number is what the outside world dials.'}
                      </p>

                      {state.line.carrier?.voipms ? (
                        <div
                          className="stack"
                          style={{
                            gap: 10,
                            padding: '12px 14px',
                            border: '1px dashed var(--border)',
                            borderRadius: 'var(--radius)',
                          }}
                        >
                          <strong style={{ fontSize: '0.9rem' }}>Or rent one from VoIP.ms</strong>
                          <div className="row wrap" style={{ gap: 10, alignItems: 'flex-end' }}>
                            <Input
                              label="Area code or prefix"
                              inputMode="numeric"
                              placeholder="415"
                              value={buy.query}
                              onChange={(event) => setBuy({ ...buy, query: event.target.value.replace(/\D/g, '').slice(0, 6) })}
                            />
                            <Input
                              label="State"
                              placeholder="CA"
                              value={buy.region}
                              onChange={(event) => setBuy({ ...buy, region: event.target.value.replace(/[^A-Za-z]/g, '').slice(0, 2).toUpperCase() })}
                            />
                            <Button loading={busy === 'buy-search'} disabled={buy.query.trim().length < 3} onClick={searchNumbers}>
                              Search the carrier
                            </Button>
                          </div>
                          {buy.items.length ? (
                            <div className="stack" style={{ gap: 6 }}>
                              {buy.items.slice(0, 12).map((item) => (
                                <div key={item.e164} className="row" style={{ gap: 10, alignItems: 'center' }}>
                                  <span className="mono tiny">{item.e164}</span>
                                  <span className="tiny dim" style={{ minWidth: 0, flex: 1 }}>
                                    {item.description || item.rateCenter || ''}
                                  </span>
                                  <Button
                                    size="sm"
                                    loading={busy === `buy-${item.e164}`}
                                    disabled={item.alreadyHeld}
                                    onClick={() => buyNumber(item.e164)}
                                  >
                                    {item.alreadyHeld ? 'Already held' : 'Rent it'}
                                  </Button>
                                </div>
                              ))}
                              <span className="tiny dim">
                                Rent is billed monthly and appears as a line on your invoice, next to the plan fee.
                              </span>
                            </div>
                          ) : null}
                        </div>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ol>

        {state.complete ? (
          <>
            <div className="row wrap" style={{ gap: 12, alignItems: 'center' }}>
              <Badge tone="success">Setup complete</Badge>
              <Button variant="primary" onClick={() => refresh()}>
                Open the console
              </Button>
              <Button
                icon="mail"
                loading={busy === 'welcome'}
                onClick={() =>
                  run('welcome', () => api.post('/onboarding/welcome', {}), 'Welcome email on its way')
                }
              >
                Resend the welcome email
              </Button>
            </div>
            <p className="tiny dim" style={{ margin: 0 }}>
              A welcome message with your line, number and sign-in link was sent to {state.email.address} when the
              account was created.
            </p>
          </>
        ) : (
          <div className="row wrap" style={{ gap: 10, alignItems: 'center' }}>
            <p className="tiny dim" style={{ margin: 0 }}>
              Step {state.steps.filter((step) => step.done).length + 1} of {state.steps.length}: {state.steps.find((step) => step.id === state.next)?.title}. The console opens when the last one is answered.
            </p>
            <Button
              size="sm"
              className="ghost"
              loading={busy === 'welcome'}
              onClick={() => run('welcome', () => api.post('/onboarding/welcome', {}), 'Welcome email on its way')}
            >
              Resend the welcome email
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
