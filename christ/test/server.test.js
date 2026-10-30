import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { createServer as createProbe } from 'node:net';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

function freePort() {
  return new Promise((resolve) => {
    const probe = createProbe();
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

async function until(url, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return response;
      last = new Error(`HTTP ${response.status}`);
    } catch (error) {
      last = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw last || new Error(`not ready: ${url}`);
}

test('the front door serves the board, the plan, the souls and a proxied product', async (t) => {
  // A product to proxy to: it echoes the path it was asked for, which is how a
  // prefix rewrite is proven rather than assumed.
  const upstream = createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ path: request.url, stub: true }));
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => upstream.close(resolve)));

  const port = await freePort();
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      // A switch that is not there: the board must still answer.
      CANTUS_URL: 'http://127.0.0.1:1',
      CANTUS_CONTROL_TOKEN: '',
      TELNO_URL: `http://127.0.0.1:${upstream.address().port}`,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', (chunk) => (log += chunk));
  child.stderr.on('data', (chunk) => (log += chunk));
  t.after(() => child.kill());

  const base = `http://127.0.0.1:${port}`;
  await until(`${base}/healthz`);

  const health = await (await fetch(`${base}/healthz`)).json();
  assert.equal(health.service, 'christ');

  const page = await fetch(`${base}/`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /CHRIST/);

  const board = await (await fetch(`${base}/api/board`)).json();
  assert.equal(board.layers.length, 6);
  assert.ok(board.projects.length >= 15, 'every project in the tree is on the board');
  assert.equal(board.switch.reachable, false, 'an absent switch is reported, not invented');
  assert.equal(board.wiring.did, '14132642700');
  assert.equal(board.wiring.lines.length, 3);
  assert.ok(board.wiring.agents.some((agent) => agent.ext === '8003'));

  const plan = await (await fetch(`${base}/api/plan`)).json();
  assert.equal(plan.did, '14132642700');
  assert.ok(plan.routes.some((route) => route.name === 'did-14132642700-office'));
  assert.equal(plan.trunks[0].endpoint, 'voipms@gateway');
  assert.equal(plan.agents.length, 3);

  const souls = await (await fetch(`${base}/api/souls`)).json();
  assert.equal(souls.souls.length, 3);
  assert.ok(souls.souls.every((soul) => soul.prompt.length > 200));

  // The prefix is rewritten, the query survives, and the product's own path is
  // preserved: a proxy that drops either is a proxy that breaks half the apps.
  const proxied = await (await fetch(`${base}/p/telno/hello?x=1`)).json();
  assert.deepEqual(proxied, { path: '/hello?x=1', stub: true });

  const missing = await fetch(`${base}/p/cantus/`);
  assert.equal(missing.status, 404);
  assert.match((await missing.json()).error, /no reachable product 'cantus'/);

  const unknown = await fetch(`${base}/nope`);
  assert.equal(unknown.status, 404);
});
