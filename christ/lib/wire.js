/**
 * The wiring: one declaration in, the switch's whole dial plan out.
 *
 * Every product in this tree can already ask the switch to route something.
 * What none of them can do is describe the *system* — which DID belongs to
 * which line, which line becomes which agent after hours, which number leaves
 * through which trunk. That description lives in `estate.json`, and this module
 * turns it into the three documents the switch actually reads (lines, trunks,
 * routing document) and applies them idempotently through the control API.
 *
 * The document is validated with the switch's own `Router` before it is sent,
 * not with a copy of the rules: a plan CHRIST accepts and the switch rejects
 * would be a bug in CHRIST, and the import makes that impossible to ship quietly.
 */

import { Router } from '../../apps/cantus-switch/src/router.js';

const digits = (value) => String(value ?? '').replace(/\D/g, '');
const plain = (value, fallback = '') =>
  String(value ?? '')
    .replace(/[^\x20-\x7E]/g, '')
    .trim()
    .slice(0, 64) || fallback;

/**
 * Every name a carrier might use for one DID.
 *
 * Carriers disagree on the request URI for a North American number: eleven
 * digits, ten, or a leading `+`. Missing one of them is a number that rings
 * nothing while the log says the route exists.
 */
export function didNames(did) {
  const number = digits(did);
  if (!number) throw new Error('estate.json: did is empty');
  if (number.length === 11 && number.startsWith('1')) return [number, number.slice(1), `+${number}`];
  return [number, `+${number}`];
}

/** The line inventory the switch registers. */
export function buildLines(estate) {
  return (estate.lines || []).map((line) => ({
    ext: String(line.ext),
    displayName: plain(line.displayName, String(line.ext)),
    numbers: (line.numbers || []).map(digits).filter(Boolean),
    voicemail: line.voicemail !== false,
    dnd: !!line.dnd,
    forwardTo: line.forwardTo ? String(line.forwardTo) : '',
  }));
}

/** The trunk: a Cantus endpoint on the gateway, never a SIP credential here. */
export function buildTrunks(estate) {
  const trunk = estate.trunk;
  if (!trunk?.name) return [];
  return [
    {
      name: String(trunk.name),
      endpoint: String(trunk.endpoint || `${trunk.name}@gateway`),
      numbers: trunk.from ? [digits(trunk.from)] : [],
      from: digits(trunk.from || ''),
      enabled: true,
    },
  ];
}

/**
 * The routing document, in the order that decides the dial plan.
 *
 * Order is the dial plan: a DID is eleven digits and would also match the
 * national outbound pattern, so the DID routes go first and the outbound
 * pattern goes last. A route that answered everything would hide every mistake
 * below it, which is why the default is a rejection.
 */
export function buildRoutes(estate) {
  const domain = estate.domain || 'estate.local';
  const agentApp = estate.agentApp || 'dograh';
  const routes = [];
  const lines = buildLines(estate);
  const agents = estate.agents || [];

  // ---- the DID ------------------------------------------------------------
  // Office hours ring a person; outside them the AI receptionist answers.
  // Both are real routes on the same number, chosen by time, which is the
  // cheapest way to prove the AI plane and the human plane are one system.
  const office = estate.officeHours;
  if (estate.did) {
    for (const name of didNames(estate.did)) {
      if (office?.line) {
        const actions = [
          { bridge: { to: String(office.line), timeout: 25 } },
          { play: { file: 'voicemail-greeting' } },
          { record: { name: `vm-${plain(office.line)}-${digits(estate.did)}` } },
          { reject: 0 },
        ];
        routes.push({
          name: `did-${name}-office`,
          when: { to: `${name}*`, weekday: office.weekday || ['mon', 'tue', 'wed', 'thu', 'fri'], time: office.time || '09:00-17:00' },
          then: actions,
        });
      }
      if (estate.afterHours?.agent) {
        routes.push({
          name: `did-${name}-after-hours`,
          when: { to: `${name}*` },
          then: [{ answer: {} }, { ari: { app: agentApp } }],
        });
      }
    }
  }

  // ---- agents -------------------------------------------------------------
  // An agent number is an ordinary address on this switch that hands the call
  // to the agent runtime. `ari` is terminal, so nothing follows it.
  for (const agent of agents) {
    routes.push({
      name: `agent-${plain(agent.ext)}`,
      when: { to: `${plain(agent.ext)}@*` },
      then: [{ answer: {} }, { ari: { app: agentApp } }],
    });
  }

  // ---- lines --------------------------------------------------------------
  for (const line of lines) {
    const actions = [];
    if (line.dnd) {
      actions.push({ reject: 1 }); // busy is an answer; silence is not
    } else if (line.forwardTo) {
      actions.push({ forward: { to: line.forwardTo } });
    } else {
      actions.push({ bridge: { to: line.ext, timeout: 25 } });
      if (line.voicemail) {
        actions.push({ play: { file: 'voicemail-greeting' } });
        actions.push({ record: { name: `vm-${plain(line.ext)}` } });
      }
      actions.push({ reject: 0 });
    }
    routes.push({ name: `line-${plain(line.ext)}`, when: { to: `${plain(line.ext)}@*` }, then: actions });
  }

  // ---- internal dialling --------------------------------------------------
  routes.push({
    name: 'internal-1xx',
    when: { to: '1??@*' },
    then: [{ bridge: { to: '*', timeout: 25 } }, { reject: 1 }],
  });

  // ---- outbound -----------------------------------------------------------
  if (buildTrunks(estate).length) {
    routes.push({ name: 'national', when: { to: '1??????????@*' }, then: [{ trunk: { to: '*' } }] });
    routes.push({
      name: 'outbound',
      when: { to: '+*' },
      then: [{ trunk: { to: '*' } }, { reject: 1 }],
    });
  }

  return {
    version: 1,
    domain,
    notes: [
      `office hours: ${office?.time || 'always'} ${(office?.weekday || []).join(',')} → line ${office?.line || '—'}`,
      estate.afterHours?.agent ? `after hours: agent ${estate.afterHours.agent}` : 'after hours: none',
      'generated by mega/lib/wire.js from mega/estate.json — do not hand-edit',
    ],
    default: { reject: 3 },
    routes,
  };
}

/** The three documents, as the switch wants them. */
export function buildPlan(estate) {
  const plan = {
    lines: buildLines(estate),
    trunks: buildTrunks(estate),
    routes: buildRoutes(estate),
  };
  // Throws RoutingError with the switch's own message if the plan is not a
  // valid Cantus document. This is the check that makes `apply` safe to call.
  new Router({ doc: plan.routes, name: 'mega' });
  return plan;
}

async function call(baseUrl, path, { method = 'GET', body, token, fetchImpl = fetch } = {}) {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const response = await fetchImpl(`${baseUrl.replace(/\/$/, '')}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  const text = await response.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  if (!response.ok) {
    const detail = parsed && typeof parsed === 'object' ? parsed.error || JSON.stringify(parsed) : String(parsed || '');
    throw new Error(`${method} ${path} → ${response.status}${detail ? `: ${detail}` : ''}`);
  }
  return parsed;
}

/**
 * Apply a plan, then read it back.
 *
 * Read back, not "sent": a 200 on `POST /v1/routes` that leaves the previous
 * document loaded is not a wiring change, and the difference only shows up
 * during the first call if nobody checks.
 */
export async function apply(plan, { baseUrl, token = '', fetchImpl = fetch } = {}) {
  if (!baseUrl) throw new Error('apply: a switch base URL is required');

  for (const trunk of plan.trunks) await call(baseUrl, '/v1/trunks', { method: 'POST', body: trunk, token, fetchImpl });
  for (const line of plan.lines) await call(baseUrl, '/v1/lines', { method: 'POST', body: line, token, fetchImpl });
  await call(baseUrl, '/v1/routes', { method: 'POST', body: plan.routes, token, fetchImpl });

  const [routes, lines, status] = await Promise.all([
    call(baseUrl, '/v1/routes', { token, fetchImpl }),
    call(baseUrl, '/v1/lines', { token, fetchImpl }),
    call(baseUrl, '/v1/status', { token, fetchImpl }),
  ]);

  const loaded = Array.isArray(routes?.routes) ? routes.routes.map((route) => route.name) : [];
  const wanted = plan.routes.routes.map((route) => route.name);
  const missing = wanted.filter((name) => !loaded.includes(name));
  if (missing.length) throw new Error(`switch did not load ${missing.length} route(s): ${missing.join(', ')}`);

  const registered = Array.isArray(lines) ? lines.map((line) => String(line.ext)) : [];
  const absent = plan.lines.map((line) => line.ext).filter((ext) => !registered.includes(ext));

  return {
    trunks: plan.trunks.length,
    lines: plan.lines.length,
    routes: wanted.length,
    loadedRoutes: loaded.length,
    linesMissing: absent,
    did: plan.routes.routes.find((route) => route.name.startsWith('did-'))?.when?.to || '',
    switch: { id: status?.id || '', domain: status?.domain || '', mode: status?.mode || '' },
  };
}

/** True when the plan can answer for the DID at all. */
export function dialPlanFor(plan, address, ctx = {}) {
  return new Router({ doc: plan.routes }).decide({ to: address, ...ctx });
}
