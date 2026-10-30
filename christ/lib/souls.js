/**
 * Souls: how an agent's identity becomes the text it is spoken from.
 *
 * Soulforge owns the soul format and the live compiler; this module is the
 * estate's copy of that contract, deliberately small: front matter names the
 * extension, the voice and the model, and the body is the system prompt,
 * normalised so that the same soul always compiles to the same bytes. An agent
 * is only wired when its soul exists and names an extension the estate's dial
 * plan routes, so a number cannot end up pointing at an agent nobody wrote.
 */

import { readFileSync, readdirSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, basename } from 'node:path';

const REQUIRED = ['ext', 'name'];

function unquote(value) {
  const text = String(value ?? '').trim();
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
    return text.slice(1, -1);
  }
  return text;
}

/**
 * Front matter, one `key: value` per line.
 *
 * A YAML parser would be a dependency for six scalars. Anything nested is a
 * soul that has outgrown this format, and it is refused rather than half-read.
 */
export function parseFrontMatter(text) {
  const source = String(text ?? '').replace(/\r\n/g, '\n');
  if (!source.startsWith('---\n')) throw new Error('a soul must start with a --- front matter block');
  const end = source.indexOf('\n---', 3);
  if (end < 0) throw new Error('a soul has an unterminated --- front matter block');
  const head = source.slice(4, end);
  const body = source.slice(end + 4).replace(/^\n/, '');

  const meta = {};
  for (const line of head.split('\n')) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const at = line.indexOf(':');
    if (at < 0) throw new Error(`front matter line is not 'key: value': ${line.trim()}`);
    const key = line.slice(0, at).trim();
    const value = line.slice(at + 1).trim();
    if (!key) throw new Error(`front matter line has no key: ${line.trim()}`);
    if (value.startsWith('{') || value.startsWith('[')) {
      throw new Error(`front matter '${key}' is nested; the soul format is flat scalars only`);
    }
    meta[key] = unquote(value);
  }
  return { meta, body };
}

/** Normalise the body so one soul compiles to one prompt, byte for byte. */
export function normalise(body) {
  const lines = String(body ?? '')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/, ''));

  const out = [];
  let blank = 0;
  for (const line of lines) {
    if (!line.trim()) {
      blank += 1;
      if (blank > 1 || out.length === 0) continue;
      out.push('');
      continue;
    }
    blank = 0;
    out.push(line);
  }
  while (out.length && out[out.length - 1] === '') out.pop();
  return out.join('\n');
}

/**
 * Compile one soul.
 *
 * The body is the prompt. Nothing is prepended to it: an agent's instruction
 * that begins with the editor's own sentence is an agent that argues with its
 * author. The name and extension travel in the document, not in the text.
 */
export function compileSoul(text, file = 'soul.md') {
  const { meta, body } = parseFrontMatter(text);
  for (const key of REQUIRED) {
    if (!meta[key]) throw new Error(`${file}: front matter needs '${key}'`);
  }
  const ext = String(meta.ext).replace(/\D/g, '');
  if (!/^\d{3,5}$/.test(ext)) throw new Error(`${file}: ext must be 3 to 5 digits, got '${meta.ext}'`);
  const prompt = normalise(body);
  if (!prompt) throw new Error(`${file}: the soul has no body, so it has no prompt`);
  return {
    file: basename(file),
    ext,
    name: String(meta.name),
    voice: String(meta.voice || ''),
    model: String(meta.model || ''),
    temperature: meta.temperature === undefined ? null : Number(meta.temperature),
    ari: String(meta.ari || ''),
    prompt,
    bytes: Buffer.byteLength(prompt, 'utf8'),
  };
}

/** Every soul in a directory, keyed by extension; a duplicate is an error. */
export function loadSouls(dir) {
  const files = readdirSync(dir)
    .filter((name) => name.endsWith('.md'))
    .sort();
  const souls = [];
  const byFile = new Map();
  for (const file of files) {
    const soul = compileSoul(readFileSync(join(dir, file), 'utf8'), file);
    if (byFile.has(soul.file)) throw new Error(`two souls named ${soul.file}`);
    byFile.set(soul.file, soul);
    souls.push(soul);
  }
  const exts = new Map();
  for (const soul of souls) {
    const clash = exts.get(soul.ext);
    if (clash) throw new Error(`extension ${soul.ext} is claimed by both ${clash} and ${soul.file}`);
    exts.set(soul.ext, soul.file);
  }
  return { souls, byFile, byExt: exts };
}

/**
 * The agent document the estate runs on.
 *
 * One entry per declared agent: the extension the dial plan routes, the ARI
 * application that answers it, and the compiled prompt. This is the hand-off
 * between the AI plane and the voice plane — capstone imports the prompt into a
 * workflow, and the switch only ever sees an extension and an ARI app.
 */
export function agentsDocument(estate, { byFile, byExt }) {
  const declared = estate.agents || [];
  const seen = new Set();
  const agents = [];

  for (const agent of declared) {
    const soul = byFile.get(String(agent.soul));
    if (!soul) throw new Error(`estate.json names agent ${agent.name} with soul '${agent.soul}', which does not exist`);
    if (String(soul.ext) !== String(agent.ext)) {
      throw new Error(`${agent.soul} declares ext ${soul.ext} but estate.json wires it to ${agent.ext}`);
    }
    if (seen.has(soul.ext)) throw new Error(`agent extension ${soul.ext} is declared twice`);
    seen.add(soul.ext);
    agents.push({
      ext: soul.ext,
      name: agent.name || soul.name,
      ari: estate.agentApp || 'dograh',
      voice: soul.voice,
      model: soul.model,
      temperature: soul.temperature,
      prompt: soul.prompt,
      soul: soul.file,
    });
  }

  // A soul nobody wired is a prompt that will never be tested by a caller.
  const unwired = [...byExt.entries()].filter(([ext]) => !seen.has(ext)).map(([, file]) => file);
  return {
    version: 1,
    generatedBy: 'mega/lib/souls.js',
    agentApp: estate.agentApp || 'dograh',
    agents,
    unwired,
  };
}

/** Write the agent document where the AI plane reads it. */
export function writeAgentsDocument(doc, dir) {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'agents.json');
  writeFileSync(path, `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
  return path;
}
