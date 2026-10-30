/**
 * What the Fax screen is allowed to say.
 *
 * The screen used to report `res_fax` and `spandsp` as "not loaded", which was
 * true and useless: this estate has no Asterisk on the call path, so those
 * modules cannot load and the message named a machine that does not exist. What
 * matters is whether a fax machine is configured, whether it answers, and which
 * of its parts is missing — so that is what these tests pin down.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { faxEngineReport } from '../src/lib/fax.js';

const facts = (over = {}) => ({
  enabled: true,
  stationId: 'Telno',
  dir: '/data/faxes',
  ghostscript: '10.00.0',
  gateway: '',
  engineUrl: '',
  ...over,
});

test('no engine configured: not ready, and the reason names both ways to fix it', () => {
  const report = faxEngineReport(facts(), null);
  assert.equal(report.ready, false);
  assert.equal(report.transport, 'none — Cantus carries voice only');
  assert.match(report.note, /FAX_ENGINE_URL/);
  assert.match(report.note, /FAX_GATEWAY/);
  // The one check that is about this process, not the fax machine.
  assert.equal(report.checks.find((c) => c.id === 'ghostscript').state, 'ready');
  assert.equal(report.checks.find((c) => c.id === 'engine').state, 'missing');
});

test('an engine that does not answer is never reported as ready', () => {
  const report = faxEngineReport(facts({ engineUrl: 'http://fax:8080' }), { reachable: false, error: 'connect ECONNREFUSED' });
  assert.equal(report.ready, false);
  assert.match(report.transport, /IAX2 .* iaxmodem .* HylaFAX \(not answering\)/);
  assert.match(report.note, /not answering/);
  assert.equal(report.checks.find((c) => c.id === 'engine').state, 'degraded');
});

test('an engine up with its modem registered is ready, and says so plainly', () => {
  const engine = {
    reachable: true,
    engine: 'iax+hylafax',
    modem: { device: 'ttyIAX0', registered: true, state: 'READY' },
    hylafax: { ready: true, version: '6.0.7' },
  };
  const report = faxEngineReport(facts({ engineUrl: 'http://fax:8080' }), engine);
  assert.equal(report.ready, true);
  assert.equal(report.transport, 'IAX2 → iaxmodem → HylaFAX');
  assert.equal(report.checks.find((c) => c.id === 'iax').detail, 'ttyIAX0 registered · READY');
  assert.match(report.note, /No carrier fax API and no per-page fee/);
});

test('an engine up with a dead modem is not ready, and blames the modem', () => {
  const engine = { reachable: true, modem: { registered: false }, hylafax: { ready: true } };
  const report = faxEngineReport(facts({ engineUrl: 'http://fax:8080' }), engine);
  assert.equal(report.ready, false, 'a reachable engine with no line cannot send or receive');
  assert.equal(report.checks.find((c) => c.id === 'iax').state, 'missing');
  assert.match(report.note, /IAX2 modem is not registered/);
});

test('the T.38 route still works, and is not confused with an engine', () => {
  const report = faxEngineReport(facts({ gateway: 'fax@gateway.estate.local' }), null);
  assert.equal(report.ready, true);
  assert.equal(report.transport, 'T.38 through fax@gateway.estate.local');
  assert.equal(report.checks.some((c) => c.id === 'iax'), false);
});

test('fax switched off is off, whatever is configured', () => {
  const report = faxEngineReport(facts({ enabled: false, gateway: 'fax@gateway' }), null);
  assert.equal(report.ready, false);
  assert.equal(report.transport, 'off');
  assert.match(report.note, /Fax is off/);
});

test('a missing renderer is the first thing named, because nothing else can work', () => {
  const report = faxEngineReport(facts({ ghostscript: null, engineUrl: 'http://fax:8080' }), null);
  assert.equal(report.ready, false);
  assert.match(report.note, /Ghostscript is missing/);
  assert.equal(report.checks[0].id, 'ghostscript');
});
