import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildPlan, apply, dialPlanFor, didNames } from '../lib/wire.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const estate = JSON.parse(readFileSync(join(HERE, '../estate.json'), 'utf8'));
const plan = buildPlan(estate);

// A Monday at 10:00 and the same Monday at 22:00, in local time, because the
// router's `time` predicate reads the wall clock the switch runs on.
const MONDAY_10 = new Date(2026, 9, 26, 10, 0, 0).getTime();
const MONDAY_22 = new Date(2026, 9, 26, 22, 0, 0).getTime();

test('the plan is a routing document the switch itself accepts', () => {
  assert.equal(plan.routes.version, 1);
  assert.ok(plan.routes.routes.length > 8);
  const names = plan.routes.routes.map((route) => route.name);
  assert.equal(new Set(names).size, names.length, 'route names must be unique');
  assert.equal(plan.routes.default.reject, 3);
});

test('the DID has an office-hours route and an after-hours route for every dialling form', () => {
  assert.deepEqual(didNames('14132642700'), ['14132642700', '4132642700', '+14132642700']);
  for (const name of didNames(estate.did)) {
    assert.ok(
      plan.routes.routes.some((route) => route.name === `did-${name}-office`),
      `missing office route for ${name}`
    );
    assert.ok(
      plan.routes.routes.some((route) => route.name === `did-${name}-after-hours`),
      `missing after-hours route for ${name}`
    );
  }
});

test('in office hours the DID rings the front desk and falls back to voicemail', () => {
  const decision = dialPlanFor(plan, '14132642700@estate.local', { now: MONDAY_10 });
  assert.equal(decision.matched, true);
  assert.equal(decision.route, 'did-14132642700-office');
  const actions = decision.actions.map((action) => Object.keys(action)[0]);
  assert.deepEqual(actions, ['bridge', 'play', 'record', 'reject']);
  assert.equal(decision.actions[0].bridge.to, '101');
});

test('outside office hours the DID answers with the AI receptionist', () => {
  const decision = dialPlanFor(plan, '14132642700@estate.local', { now: MONDAY_22 });
  assert.equal(decision.route, 'did-14132642700-after-hours');
  assert.deepEqual(decision.actions, [{ answer: {} }, { ari: { app: 'dograh' } }]);
});

test('the DID also answers the ten-digit and plus forms a carrier might use', () => {
  for (const address of ['4132642700@estate.local', '+14132642700@estate.local']) {
    const decision = dialPlanFor(plan, address, { now: MONDAY_10 });
    assert.equal(decision.route, `did-${address.split('@')[0]}-office`, `wrong route for ${address}`);
  }
});

test('the DID route wins over the national outbound pattern', () => {
  // Both patterns match; only the order decides. An inbound DID that leaves
  // through the trunk is a call that comes back as its own caller.
  const decision = dialPlanFor(plan, '14132642700@estate.local', { now: MONDAY_10 });
  assert.notEqual(decision.route, 'national');
});

test('any other eleven-digit number leaves through the trunk', () => {
  const decision = dialPlanFor(plan, '14155550100@estate.local', { now: MONDAY_10 });
  assert.equal(decision.route, 'national');
  assert.deepEqual(decision.actions, [{ trunk: { to: '*' } }]);
});

test('agent extensions hand the call to the agent runtime', () => {
  for (const agent of estate.agents) {
    const decision = dialPlanFor(plan, `${agent.ext}@estate.local`);
    assert.equal(decision.route, `agent-${agent.ext}`);
    assert.equal(decision.actions.at(-1).ari.app, 'dograh');
  }
});

test('a line rings its extension, then takes a message, then releases the call', () => {
  const decision = dialPlanFor(plan, '101@estate.local');
  assert.equal(decision.route, 'line-101');
  assert.deepEqual(decision.actions.map((action) => Object.keys(action)[0]), ['bridge', 'play', 'record', 'reject']);
});

test('an internal short number bridges, and anything unclaimed is rejected', () => {
  assert.equal(dialPlanFor(plan, '109@estate.local').route, 'internal-1xx');
  const unclaimed = dialPlanFor(plan, '999@estate.local');
  assert.equal(unclaimed.matched, false);
  assert.deepEqual(unclaimed.actions, [{ reject: 3 }]);
});

test('the trunk is a Cantus endpoint, never a SIP credential', () => {
  assert.equal(plan.trunks.length, 1);
  assert.equal(plan.trunks[0].endpoint, 'voipms@gateway');
  assert.equal(plan.trunks[0].from, '14132642700');
});

/** A switch that keeps exactly as much state as `apply` reads back. */
function stubSwitch({ ignoreRoutes = false } = {}) {
  const state = { trunks: [], lines: new Map(), routes: null };
  const server = createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null;
      const send = (status, value) => {
        response.writeHead(status, { 'content-type': 'application/json' });
        response.end(JSON.stringify(value));
      };
      if (request.url === '/v1/trunks' && request.method === 'POST') {
        state.trunks.push(body);
        return send(200, { ok: true });
      }
      if (request.url === '/v1/lines' && request.method === 'POST') {
        state.lines.set(String(body.ext), body);
        return send(200, { ok: true, ext: body.ext });
      }
      if (request.url === '/v1/routes' && request.method === 'POST') {
        if (!ignoreRoutes) state.routes = body;
        return send(200, { ok: true, routes: body.routes.length });
      }
      if (request.url === '/v1/routes' && request.method === 'GET') return send(200, state.routes);
      if (request.url === '/v1/lines' && request.method === 'GET') return send(200, [...state.lines.values()]);
      if (request.url === '/v1/status' && request.method === 'GET') {
        return send(200, { id: 'switch@estate.local', domain: 'estate.local', mode: 'direct' });
      }
      return send(404, { error: 'not found' });
    });
  });
  return { server, state };
}

test('apply sends the trunk, every line and the document, then reads it back', async (t) => {
  const { server, state } = stubSwitch();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const result = await apply(plan, { baseUrl, token: 'secret' });

  assert.equal(result.trunks, 1);
  assert.equal(result.lines, plan.lines.length);
  assert.equal(result.loadedRoutes, plan.routes.routes.length);
  assert.deepEqual(result.linesMissing, []);
  assert.equal(state.routes.routes.length, plan.routes.routes.length);
  assert.equal(state.lines.size, plan.lines.length);
});

test('apply fails when the switch answers 200 but keeps the previous document', async (t) => {
  const { server } = stubSwitch({ ignoreRoutes: true });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  await assert.rejects(() => apply(plan, { baseUrl }), /did not load/);
});

test('apply reports a line the switch did not keep', async (t) => {
  const { server, state } = stubSwitch();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  // A switch that drops line 102 on the floor: apply must say so, not pass.
  const original = state.lines.set.bind(state.lines);
  state.lines.set = (key, value) => (key === '102' ? state.lines : original(key, value));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const result = await apply(plan, { baseUrl });
  assert.deepEqual(result.linesMissing, ['102']);
});
