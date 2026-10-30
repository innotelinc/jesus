import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadCatalog, resolve, composeCommand, CORE } from '../lib/catalog.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const catalog = loadCatalog(join(HERE, '../catalog.json'));

test('"voice" is the floor: the switch and the front door', () => {
  const resolution = resolve(catalog, ['voice']);
  assert.deepEqual(resolution.services, ['switch', 'christ']);
  assert.deepEqual(resolution.profiles, [CORE, 'voice']);
});

test('"ai" resolves to containers and to the stacks that stay outside', () => {
  const resolution = resolve(catalog, ['ai']);
  assert.deepEqual(resolution.capabilities, ['models', 'voice', 'agents', 'memory', 'tools']);
  assert.deepEqual(resolution.services, ['omniroute', 'switch', 'christ']);
  const attached = resolution.external.map((entry) => entry.name);
  assert.ok(attached.includes('Capstone + dograh'), 'the agent stack is attached, not pretended');
  assert.ok(attached.includes('claude-mem'));
});

test('a capability brings what it requires, once, dependency first', () => {
  const resolution = resolve(catalog, ['agents']);
  assert.equal(resolution.capabilities.indexOf('voice') < resolution.capabilities.indexOf('agents'), true);
  assert.equal(resolution.capabilities.filter((id) => id === 'voice').length, 1);
  assert.ok(resolution.services.includes('omniroute'));
});

test('pstn needs the voice plane and asks for carrier credentials', () => {
  const resolution = resolve(catalog, ['pstn']);
  assert.deepEqual(resolution.services, ['switch', 'christ', 'gateway']);
  assert.ok(resolution.env.includes('VOIPMS_SIP_HOST'));
});

test('several wishes resolve together, duplicates once', () => {
  const resolution = resolve(catalog, ['platform', 'console', 'models']);
  assert.deepEqual(resolution.services, ['switch', 'christ', 'telno', 'console', 'omniroute']);
  assert.equal(new Set(resolution.profiles).size, resolution.profiles.length);
});

test('an unknown capability is refused with the list of real ones', () => {
  assert.throws(() => resolve(catalog, ['telepathy']), /unknown capability: telepathy — available: voice, pstn/);
});

test('an empty selection is a question, not a default', () => {
  assert.throws(() => resolve(catalog, []), /say what you want/);
});

test('a cycle in the catalog is named instead of silently resolved', () => {
  const cyclic = {
    byId: new Map([
      ['a', { id: 'a', requires: ['b'], services: ['s1'] }],
      ['b', { id: 'b', requires: ['a'], services: ['s2'] }],
    ]),
  };
  assert.throws(() => resolve(cyclic, ['a']), /catalog cycle: a → b → a/);
});

test('the command carries every profile the selection needs', () => {
  const command = composeCommand(resolve(catalog, ['ai']));
  assert.match(command, /docker compose --profile core --profile models --profile voice --profile agents --profile memory --profile tools up -d --build/);
  assert.doesNotMatch(command, /--profile ai/, 'a bundle must not become a profile of its own');
});

test('every service a capability names is one the compose file declares', async () => {
  const { readFileSync } = await import('node:fs');
  const compose = readFileSync(join(HERE, '../compose.yml'), 'utf8');
  const named = new Set([...resolve(catalog, [...catalog.byId.keys()]).services]);
  for (const service of named) {
    // eslint-disable-next-line no-useless-escape
    const declared = new RegExp(`^  ${service}:$`, 'm').test(compose);
    assert.ok(declared, `compose.yml has no service '${service}'`);
  }
});
