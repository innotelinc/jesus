/**
 * The seven doors.
 *
 * A domain that answers with the wrong page, or with no page at all, looks like
 * a working site until somebody visits it — so the map the browser uses and the
 * map the proxy uses are checked against each other here. `christ/domains.json`
 * is the estate's declaration; `web/src/sites.js` is what each door says. A host
 * added to one and not the other fails this test rather than going live empty.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { SITES, siteFor, entryPath, hostOf } from '../web/src/sites.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const declared = JSON.parse(readFileSync(join(HERE, '../../../christ/domains.json'), 'utf8'));

test('every domain the estate declares has a landing page', () => {
  for (const { host, role } of declared.hosts) {
    const site = SITES[host];
    assert.ok(site, `${host} is declared in christ/domains.json but sites.js has no entry`);
    assert.equal(site.role, role, `${host}: role "${site.role}" does not match the declaration's "${role}"`);
  }
  assert.equal(Object.keys(SITES).length, declared.hosts.length, 'sites.js has a door the estate does not declare');
});

test('a landing page is a page, and a directory is a redirect', () => {
  for (const [host, site] of Object.entries(SITES)) {
    if (site.role === 'directory') {
      assert.equal(host, 'telno.directory');
      assert.equal(site.directory, '/d/telno.directory', 'the phonebook opens on its own canonical host');
      assert.equal(site.headline, undefined, 'a landing page in front of the directory is one click too many');
      continue;
    }
    assert.ok(site.headline?.length > 10, `${host} needs a headline`);
    assert.ok(site.lede?.length > 30, `${host} needs a lede`);
    assert.ok(site.eyebrow?.length, `${host} needs an eyebrow`);
    // A call to action is a section of this page or a screen of the app, never
    // an absolute URL: a door that leaves the product is a broken door.
    for (const action of [site.primary, site.secondary].filter(Boolean)) {
      assert.match(action.to, /^(#|\/)/, `${host}: "${action.to}" must be an anchor or an app path`);
      assert.ok(action.label?.length, `${host}: a call to action needs a label`);
    }
    assert.ok(site.primary, `${host} needs a primary action`);
  }
});

test('the port, the www and the case of a host do not change the page', () => {
  assert.equal(siteFor('TELNO.SERVICES:8090')?.role, 'product');
  assert.equal(siteFor('www.telno.mobi')?.role, 'mobile');
  assert.equal(hostOf('WWW.Telno.TEL:443'), 'telno.tel');
});

test('an unknown host falls back to the brand, not to a door', () => {
  assert.equal(siteFor('localhost:8090'), null);
  assert.equal(siteFor(''), null);
  assert.equal(siteFor('telno.example'), null);
  // The softphone and the console are served on whatever host the operator has;
  // inventing a landing page for one would be a page nobody wrote.
  assert.equal(entryPath('localhost'), null);
});

test('?site= previews a door that has no DNS yet', () => {
  assert.equal(siteFor('localhost', '?site=telno.mobi')?.role, 'mobile');
  assert.equal(siteFor('telno.tel', '?site=telno.directory')?.role, 'directory');
  // Only a host that exists can be named; the parameter is not a sanitiser.
  assert.equal(siteFor('localhost', '?site=evil.example'), null);
});
