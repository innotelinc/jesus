/**
 * The front door.
 *
 * `domains.json` is the estate's claim about its own hostnames; `deploy/Caddyfile`
 * is what the proxy actually serves. A proxy config edited by hand drifts from
 * the map within a week and the drift is invisible until a domain 404s, so the
 * committed Caddyfile is compared with a fresh render here — a mismatch means
 * somebody edited the generated file, and the fix is `node cli.js edge --write`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadDomains, renderCaddyfile, upstreamFor } from '../lib/edge.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const domains = loadDomains(join(HERE, '../domains.json'));
const committed = readFileSync(join(HERE, '../deploy/Caddyfile'), 'utf8');

test('the committed Caddyfile is the one this map renders', () => {
  assert.equal(
    committed,
    renderCaddyfile(domains),
    'deploy/Caddyfile is out of date — run `node cli.js edge --write`'
  );
});

test('all seven estate domains are routed, each to the service that owns it', () => {
  const expected = {
    'telno.services': 'telno:8080',
    'telno.online': 'telno:8080',
    'telno.mobi': 'telno:8080',
    'telno.digital': 'telno:8080',
    'telno.tel': 'telno:8080',
    'telno.directory': 'telno:8080',
    'telno.network': 'christ:8001',
  };
  for (const [host, upstream] of Object.entries(expected)) {
    const entry = upstreamFor(domains, host);
    assert.ok(entry, `${host} is not in domains.json`);
    assert.equal(entry.upstream, upstream, `${host} must reach ${upstream}`);
    // The name in the Caddyfile, not just the map: a host that renders nowhere
    // is a domain that does not answer.
    assert.match(committed, new RegExp(`^${host.replace(/\./g, '\\.')}, www\\.`, 'm'));
  }
  assert.equal(domains.hosts.length, 7);
});

test('each door has one job, and the phonebook is not a landing page', () => {
  const roles = Object.fromEntries(domains.hosts.map((entry) => [entry.host, entry.role]));
  assert.deepEqual(roles, {
    'telno.services': 'product',
    'telno.online': 'signup',
    'telno.mobi': 'mobile',
    'telno.digital': 'numbers',
    'telno.tel': 'phones',
    'telno.directory': 'directory',
    'telno.network': 'network',
  });
  // telno.directory redirects its root into the directory; anything else means a
  // page now stands between a caller and the number they came for.
  const directory = upstreamFor(domains, 'telno.directory');
  assert.equal(directory.redirect, '/d/telno.directory');
});

test('mail leaves from telno.services, whatever host the app is on', () => {
  assert.equal(domains.mail.from, 'Telno <no-reply@telno.services>');
  assert.match(domains.mail.replyTo, /@telno\.services$/);
  // The sending domain has to be one of the doors, or the estate would send
  // mail from a hostname it does not serve.
  assert.ok(upstreamFor(domains, 'telno.services'), 'the sending domain must also be a routed host');
});

test('www is a door too, and the proxy never hides an upstream that is down', () => {
  const noisy = renderCaddyfile(domains);
  assert.equal((noisy.match(/www\./g) || []).length, 7, 'every host answers on www as well');
  // No error_page or handle_errors: a 502 from the estate is the honest answer.
  assert.doesNotMatch(noisy, /handle_errors|error_page/);
  // TLS is automatic, so a host must never be listed as plain :80 only.
  assert.doesNotMatch(noisy, /^\s*\w[\w.-]+,?\s*\{?\s*:80/m);
});

test('the HTTP-only render is the same map with TLS off', () => {
  const http = renderCaddyfile(domains, { httpOnly: true });
  assert.match(http, /^\s*auto_https off$/m);
  assert.doesNotMatch(renderCaddyfile(domains), /auto_https/);
  // A bare hostname still means :443 in Caddy, so the probe render names the
  // scheme. That is the only textual difference: same hosts, same upstreams.
  assert.match(http, /^http:\/\/telno\.services, http:\/\/www\.telno\.services \{$/m);
  const strip = (text) =>
    text.replace(/^\s*auto_https off\n/m, '').replace(/^http:\/\//gm, '').replace(/, http:\/\//g, ', ');
  assert.equal(strip(http), renderCaddyfile(domains));
});

test('a malformed map is refused rather than served', () => {
  const base = { acmeEmail: 'a@b.c', hosts: [] };
  assert.throws(() => renderCaddyfile({ ...base, hosts: [{ host: 'nodots', upstream: 'x:1' }] }), /hostname/);
  assert.throws(
    () => renderCaddyfile({ ...base, hosts: [{ host: 'a.example', upstream: 'no-port' }] }),
    /upstream/
  );
  assert.throws(
    () =>
      renderCaddyfile({
        ...base,
        hosts: [
          { host: 'a.example', upstream: 'x:1' },
          { host: 'a.example', upstream: 'x:2' },
        ],
      }),
    /twice/
  );
});
