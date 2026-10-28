import { useCallback, useEffect, useState } from 'react';
import { api, prettyNumber } from '../api.js';
import {
  Badge,
  Button,
  Card,
  Icon,
  Input,
  Loading,
  PageHeader,
  useToast,
} from '../ui.jsx';
import { Link, navigate } from '../router.jsx';
import { saveLine } from '../softphoneLine.js';
import { openSoftphoneWindow } from '../softphoneWindow.js';

/**
 * First run.
 *
 * An install with no line is not "empty state" territory: nothing on the
 * platform can ring, so the useful thing is a short, ordered path to a
 * registered phone. Each step is one request to an API that already exists for
 * the Extensions and Numbers screens — this page decides the order and explains
 * what each one is for, and never becomes a second way to create a line.
 */

/**
 * Whether this install still needs a first line.
 *
 * Read by the router so an owner lands on setup instead of a dashboard of empty
 * panels, and by the shell so the console says so on every other page.
 */
export function useSetupStatus(active) {
  const [setup, setSetup] = useState(null);
  useEffect(() => {
    if (!active) {
      setSetup(null);
      return undefined;
    }
    let canceled = false;
    api
      .get('/setup')
      .then((data) => {
        if (!canceled) setSetup(data);
      })
      .catch(() => {
        // A failure here is not worth a toast on every page: the console still
        // works and the setup page itself reports the error.
        if (!canceled) setSetup(null);
      });
    return () => {
      canceled = true;
    };
  }, [active]);
  return setup;
}

export default function Setup() {
  const toast = useToast();
  const [setup, setSetup] = useState(null);
  const [form, setForm] = useState({ displayName: '', extension: '' });
  const [line, setLine] = useState(null);
  const [number, setNumber] = useState('');
  const [attached, setAttached] = useState(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      const data = await api.get('/setup');
      setSetup(data);
      setForm((current) => ({
        displayName: current.displayName || data.suggested.displayName,
        extension: current.extension || data.suggested.extension,
      }));
    } catch (err) {
      setError(err.message);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const createLine = async () => {
    setBusy('line');
    setError('');
    try {
      const result = await api.post('/setup/line', {
        displayName: form.displayName,
        extension: form.extension,
      });
      setLine(result.extension);
      toast.success(`Line ${result.extension.extension} created`, 'The switch has already reloaded with it');
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy('');
    }
  };

  const attachNumber = async () => {
    setBusy('number');
    setError('');
    try {
      const result = await api.post('/setup/number', {
        extension: line?.extension || form.extension,
        number: number.trim(),
      });
      setAttached(result.extension.number);
      toast.success('Number attached', prettyNumber(result.extension.number?.e164));
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy('');
    }
  };

  const connect = async (ownWindow) => {
    const extension = line?.extension || '';
    if (!extension) {
      toast.error('Create a line first', 'A phone registers against an extension');
      return;
    }
    // The softphone reads this and registers without being asked, which is the
    // whole point of the last step.
    saveLine({ extension, keep: true });
    if (!ownWindow) {
      navigate('/softphone');
      return;
    }
    const result = await openSoftphoneWindow();
    if (result.blocked) toast.error('The window was blocked', 'Allow popups for this site, then try again');
  };

  const header = (
    <PageHeader
      title="Get started"
      subtitle="Three steps from a fresh install to a phone that rings"
      actions={
        setup ? (
          <Badge tone={setup.switch?.connected ? 'success' : setup.switch?.simulated ? 'warning' : 'danger'} dot>
            {setup.switch?.connected ? 'Switch connected' : setup.switch?.simulated ? 'Simulated switch' : 'Switch offline'}
          </Badge>
        ) : null
      }
    />
  );

  if (!setup) {
    return (
      <>
        {header}
        <Card>
          {error ? (
            <p className="tiny" style={{ color: 'var(--danger)' }}>
              {error}
            </p>
          ) : (
            <Loading rows={3} />
          )}
        </Card>
      </>
    );
  }

  const lineDone = setup.steps.find((step) => step.id === 'line')?.done;
  const numberDone = !!attached || setup.steps.find((step) => step.id === 'number')?.done;
  const current = !lineDone ? 'line' : !numberDone ? 'number' : 'register';

  return (
    <>
      {header}

      {setup.needed ? (
        <Card title="Why this screen" subtitle="Nothing on this platform can ring until a line exists">
          <p className="tiny muted" style={{ margin: 0, lineHeight: 1.7 }}>
            A deployment ships with an owner account and nothing else. An extension gives you a number to dial and
            an identity to register; a phone number makes you reachable from outside; registering a phone is what
            turns both into a working line. You can leave the number for later — the first two steps are enough to
            call between extensions and into the switch.
          </p>
        </Card>
      ) : null}

      {/* ---------------------------------------------------------------- line */}
      <Card
        title={
          <span className="row" style={{ gap: 10 }}>
            <span className="step-badge">1</span>
            Create your line
            {lineDone ? <Badge tone="success">done</Badge> : null}
          </span>
        }
        subtitle="An extension, its SIP endpoint and a voicemail box"
      >
        {line ? (
          <div className="stack">
            <dl className="kv">
              <dt>Extension</dt>
              <dd className="mono">{line.extension}</dd>
              <dt>Name</dt>
              <dd>{line.displayName}</dd>
              {line.number?.e164 ? (
                <>
                  <dt>Number</dt>
                  <dd className="num">{prettyNumber(line.number.e164)}</dd>
                </>
              ) : null}
            </dl>
            <p className="tiny dim" style={{ margin: 0 }}>
              The switch generated a SIP secret for this line and the softphone signs in with it for you. Keep it if
              you are configuring a desk phone: it is shown once.
            </p>
            <div className="panel row" style={{ gap: 8 }}>
              <span className="mono truncate" style={{ fontSize: '0.8125rem' }}>
                {line.extension} · {line.secret}
              </span>
              <Button
                size="sm"
                variant="ghost"
                icon="copy"
                className="right"
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(`${line.extension}:${line.secret}`);
                    toast.success('Credentials copied');
                  } catch {
                    toast.error('Copy failed', 'Select the text and copy it manually');
                  }
                }}
              >
                Copy
              </Button>
            </div>
          </div>
        ) : (
          <div className="stack">
            <div className="grid two" style={{ gap: 12 }}>
              <Input
                label="Display name"
                value={form.displayName}
                maxLength={80}
                onChange={(event) => setForm({ ...form, displayName: event.target.value })}
                placeholder="Front desk"
                hint="What the switch shows as the caller"
                autoFocus
              />
              <Input
                label="Extension"
                value={form.extension}
                className="mono"
                onChange={(event) => setForm({ ...form, extension: event.target.value.replace(/\D/g, '').slice(0, 6) })}
                placeholder="101"
                hint="2–6 digits · 101 is free"
              />
            </div>
            <div className="row wrap" style={{ gap: 8 }}>
              <Button
                variant="primary"
                icon="plus"
                onClick={createLine}
                loading={busy === 'line'}
                disabled={!form.displayName.trim() || form.extension.trim().length < 2}
              >
                Create the line
              </Button>
              <Link className="btn ghost sm" to="/extensions">
                See all lines
              </Link>
            </div>
          </div>
        )}
      </Card>

      {/* -------------------------------------------------------------- number */}
      <Card
        title={
          <span className="row" style={{ gap: 10 }}>
            <span className="step-badge">2</span>
            Give it a phone number
            {numberDone ? <Badge tone="success">done</Badge> : <Badge>optional</Badge>}
          </span>
        }
        subtitle="So somebody outside the switch can reach the line"
      >
        {attached || setup.steps.find((step) => step.id === 'number')?.done ? (
          <p className="tiny" style={{ margin: 0 }}>
            {attached ? (
              <>
                <Icon name="check" size={13} /> Attached <span className="num">{prettyNumber(attached.e164)}</span> to
                this line. Calls to it now ring the extension.
              </>
            ) : (
              <>
                {setup.counts.numbers} number{setup.counts.numbers === 1 ? '' : 's'} in the registry.{' '}
                <Link to="/numbers">Manage numbers</Link>
              </>
            )}
          </p>
        ) : (
          <div className="stack">
            <div className="grid two" style={{ gap: 12 }}>
              <Input
                label="Number you own"
                value={number}
                className="mono"
                onChange={(event) => setNumber(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && number.trim()) attachNumber();
                }}
                placeholder="+1 415 555 0123"
                hint="Any DID in your name — it is recorded in the registry and routed here"
              />
              <div className="row wrap" style={{ gap: 8, alignItems: 'flex-end' }}>
                <Button
                  variant="primary"
                  icon="check"
                  onClick={attachNumber}
                  loading={busy === 'number'}
                  disabled={number.trim().length < 6 || !(line?.extension || form.extension)}
                >
                  Attach to this line
                </Button>
                {setup.carrier?.voipms ? (
                  <Link className="btn ghost sm" to="/numbers">
                    Buy one at VoIP.ms
                  </Link>
                ) : null}
              </div>
            </div>
            <p className="tiny dim" style={{ margin: 0 }}>
              {setup.carrier?.voipms
                ? 'VoIP.ms is configured: search by area code on the Numbers screen to order a DID and it is attached here.'
                : 'No carrier is configured yet, so a number has to be one you already own. Add VoIP.ms credentials in Settings to buy DIDs from the console.'}
            </p>
          </div>
        )}
      </Card>

      {/* ------------------------------------------------------------ register */}
      <Card
        title={
          <span className="row" style={{ gap: 10 }}>
            <span className="step-badge">3</span>
            Register a phone
            {current === 'register' ? <Badge tone="info">next</Badge> : null}
          </span>
        }
        subtitle="The softphone signs in as the line and stays registered"
      >
        <div className="stack">
          <div className="row wrap" style={{ gap: 8 }}>
            <Button
              variant={current === 'register' ? 'primary' : ''}
              icon="phone"
              onClick={() => connect(false)}
              disabled={!line?.extension}
            >
              Open the softphone
            </Button>
            <Button variant="ghost" icon="external" onClick={() => connect(true)} disabled={!line?.extension}>
              Open it in its own window
            </Button>
          </div>
          <p className="tiny dim" style={{ margin: 0 }}>
            {line?.extension
              ? `The softphone will register extension ${line.extension} over encrypted WebSocket and keep the line up while you browse other pages.`
              : 'Create a line above and the softphone will register it without asking again.'}
          </p>
          <p className="tiny dim" style={{ margin: 0 }}>
            On an iPhone, install the SCIF app and sign in on the same line: the phone registers itself for Apple
            push, so it rings on a locked screen and answers a call the switch parks for it.
            {setup.push?.enabled ? '' : ' Push is not configured on this deployment yet (Settings → Voice), so only the browser softphone will ring.'}
          </p>
        </div>
      </Card>

      {!setup.needed && !line ? (
        <Card title="Already set up" subtitle={`${setup.counts.extensions} line${setup.counts.extensions === 1 ? '' : 's'} on this switch`}>
          <div className="row wrap" style={{ gap: 8 }}>
            <Link className="btn sm" to="/extensions">
              Extensions
            </Link>
            <Link className="btn sm" to="/numbers">
              Numbers
            </Link>
            <Link className="btn sm" to="/softphone">
              Softphone
            </Link>
          </div>
        </Card>
      ) : null}

      {error ? (
        <p className="tiny" style={{ color: 'var(--danger)' }} role="alert">
          {error}
        </p>
      ) : null}

      <p className="tiny dim" style={{ margin: 0 }}>
        Every step writes the switch configuration and reloads it — there is no apply button, and a line is live the
        moment it is saved.
      </p>
    </>
  );
}
