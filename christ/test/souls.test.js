import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseFrontMatter, normalise, compileSoul, loadSouls, agentsDocument } from '../lib/souls.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SOULS = join(HERE, '../souls');
const estate = JSON.parse(readFileSync(join(HERE, '../estate.json'), 'utf8'));

const SOUL = `---
ext: 8009
name: Test agent
voice: piper:test
model: omniroute:local
temperature: 0.2
---
# Identity

You answer the phone.
`;

test('front matter is flat scalars, and the body is the prompt', () => {
  const { meta, body } = parseFrontMatter(SOUL);
  assert.equal(meta.ext, '8009');
  assert.equal(meta.name, 'Test agent');
  assert.equal(meta.temperature, '0.2');
  assert.match(body, /# Identity/);
});

test('a soul without front matter, or with nesting, is refused', () => {
  assert.throws(() => parseFrontMatter('You answer the phone.'), /front matter/);
  assert.throws(() => compileSoul('---\next: 8009\n---\nbody', 'x.md'), /needs 'name'/);
  assert.throws(() => parseFrontMatter('---\next: 8009\nname: A\nmeta: {a: 1}\n---\nbody'), /flat scalars/);
  assert.throws(() => compileSoul('---\next: 8009\nname: A\n---\n', 'x.md'), /no body/);
});

test('compilation is byte-stable: the same soul is the same prompt twice', () => {
  const once = compileSoul(SOUL, 'test.md');
  const twice = compileSoul(SOUL.replace(/\n/g, '\r\n'), 'test.md');
  assert.equal(once.prompt, twice.prompt);
  assert.equal(once.bytes, Buffer.byteLength(once.prompt, 'utf8'));
});

test('normalisation strips trailing spaces and collapses blank runs', () => {
  assert.equal(normalise('a   \n\n\n\nb\n\n'), 'a\n\nb');
  assert.equal(normalise('\n\n  \na'), 'a');
});

test('an extension that is not a number is refused', () => {
  assert.throws(() => compileSoul(SOUL.replace('ext: 8009', 'ext: lobby'), 'x.md'), /3 to 5 digits/);
});

test('every authored soul compiles and the estate wires exactly them', () => {
  const { souls, byFile, byExt } = loadSouls(SOULS);
  assert.ok(souls.length >= 3, 'the estate ships at least three agents');
  const doc = agentsDocument(estate, { byFile, byExt });
  assert.equal(doc.agents.length, estate.agents.length);
  assert.deepEqual(doc.unwired, []);
  for (const agent of doc.agents) {
    assert.match(agent.ext, /^\d{4}$/);
    assert.ok(agent.prompt.length > 200, `${agent.name} has a prompt that says something`);
    assert.equal(agent.ari, 'dograh');
  }
  // Every declared agent says which extension the dial plan routes to it.
  for (const agent of estate.agents) {
    assert.ok(doc.agents.some((entry) => entry.ext === String(agent.ext)), `agent ${agent.ext} is missing from the document`);
  }
});

test('an agent wired to the wrong extension is an error, not a shift', () => {
  const { souls } = loadSouls(SOULS);
  const byFile = new Map(souls.map((soul) => [soul.file, soul]));
  const broken = {
    ...estate,
    agents: [{ ext: '8999', name: 'Wrong', soul: souls[0].file }],
  };
  assert.throws(() => agentsDocument(broken, { byFile, byExt: new Map() }), /wires it to 8999/);
});

test('a soul nobody wired is reported rather than silently dropped', () => {
  const { souls, byFile, byExt } = loadSouls(SOULS);
  const one = { ...estate, agents: estate.agents.slice(0, 1) };
  const doc = agentsDocument(one, { byFile, byExt });
  assert.equal(doc.unwired.length, souls.length - 1);
});
