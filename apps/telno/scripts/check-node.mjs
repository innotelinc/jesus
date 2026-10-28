#!/usr/bin/env node
/**
 * Refuse to start on a runtime older than the manifest allows.
 *
 * `npm install` is stopped by .npmrc, but a copied node_modules, a container
 * built elsewhere, or a bare `node src/index.js` all bypass that. Without this,
 * the failure is `ERR_UNKNOWN_BUILTIN_MODULE: No such built-in module: node:sqlite`
 * from three imports deep, which reads like a broken checkout rather than an old
 * runtime. This runs first and says what to do.
 *
 *   node scripts/check-node.mjs                  check the running Node
 *   node scripts/check-node.mjs --version 22.13  check a version without running it
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { floorMessage, floorOf, meetsFloor } from '../src/lib/node-version.js';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

const flag = process.argv.indexOf('--version');
const checked = flag > -1 ? process.argv[flag + 1] : process.versions.node;

const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const floor = manifest.engines?.node || '';

if (!floor) {
  console.error('package.json declares no "engines.node", so the runtime floor is unknown.');
  process.exit(1);
}

if (meetsFloor(checked, floor)) process.exit(0);

console.error(`\n${floorMessage(checked, floor)}\n`);
process.exit(1);
