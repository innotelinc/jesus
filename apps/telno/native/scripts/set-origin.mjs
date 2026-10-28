/**
 * Point the native shell at a deployment.
 *
 *   npm run origin -- https://telno.services
 *   npm run origin -- http://192.168.1.93:8080      (development, not for a phone
 *                                                    on a store build: ATS blocks
 *                                                    plain HTTP and so does the
 *                                                    microphone policy)
 *
 * The shell loads the softphone that is already deployed, so there is one build
 * to reason about: the app is the window onto it, and the platform remains the
 * thing that enforces encryption, caller ID and recording.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const arg = process.argv[2];
if (!arg) {
  console.error('Usage: npm run origin -- https://telno.services');
  process.exit(1);
}

let url;
try {
  url = new URL(arg);
} catch {
  console.error(`Not a URL: ${arg}`);
  process.exit(1);
}
if (url.protocol !== 'https:' && !/^(localhost|127\.0\.0\.1|192\.168\.|10\.)/.test(url.hostname)) {
  console.error('Plain HTTP is only accepted for a loopback or private address');
  process.exit(1);
}

const file = resolve(process.cwd(), 'capacitor.config.json');
const config = JSON.parse(readFileSync(file, 'utf8'));
const base = `${url.origin}${url.pathname.replace(/\/$/, '')}`;
config.server = config.server || {};
config.server.url = `${base.includes('/softphone') ? base : `${base}/softphone`}?window=1&scif=1`;
config.server.cleartext = url.protocol === 'http:';
config.server.allowNavigation = [url.hostname, `*.${url.hostname}`];
writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`);
console.log(`SCIF app will open ${config.server.url}`);
