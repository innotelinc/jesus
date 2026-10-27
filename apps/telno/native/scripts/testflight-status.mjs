/**
 * Ask App Store Connect what TestFlight did with the build we just uploaded.
 *
 * `altool --upload-app` returning success only means Apple accepted the bytes.
 * A build then spends a few minutes in PROCESSING before it can be installed
 * from TestFlight, and a build that fails validation sits there as INVALID with
 * no email anyone reads. This turns "the upload returned 0" into a real answer
 * about the build, and it is the difference between shipping and hoping.
 *
 *   node scripts/testflight-status.mjs
 *
 * Reads APP_STORE_CONNECT_KEY_ID, APP_STORE_CONNECT_ISSUER_ID (or the KEY_ID /
 * ISSUER_ID names the workflow exports), APP_BUNDLE_ID, APP_BUILD and the .p8 at
 * KEY_PATH. Exits 0 when the build is ready to test, 1 when Apple rejected it,
 * and 0 with a warning if it is simply still processing when the wait runs out
 * — a slow queue is not a failed build.
 */
import { createSign } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';

const API = 'https://api.appstoreconnect.apple.com';

const env = (...names) => {
  for (const name of names) {
    const value = process.env[name];
    if (value) return value;
  }
  console.error(`testflight: none of ${names.join(', ')} is set`);
  process.exit(1);
};

const keyId = env('APP_STORE_CONNECT_KEY_ID', 'KEY_ID');
const issuerId = env('APP_STORE_CONNECT_ISSUER_ID', 'ISSUER_ID');
const bundleId = env('APP_BUNDLE_ID');
const buildNumber = env('APP_BUILD');
const keyPath = process.env.KEY_PATH || `${process.env.HOME}/.appstoreconnect/private_keys/AuthKey_${keyId}.p8`;

// Processing is usually minutes. The cap is generous because a failed run here
// should mean Apple is unhappy, not that the queue was busy.
const deadline = Date.now() + Number(process.env.TIMEOUT_SECONDS || 900) * 1000;
const intervalMs = Number(process.env.INTERVAL_SECONDS || 20) * 1000;

if (!existsSync(keyPath)) {
  console.error(`testflight: no App Store Connect key at ${keyPath}`);
  process.exit(1);
}

const privateKey = readFileSync(keyPath, 'utf8');

/**
 * The API authenticates with an ES256 JWT signed by the same .p8 CI already
 * uses for signing. ieee-p1363 is what makes Node emit the raw r||s pair JWT
 * wants instead of the DER signature OpenSSL produces by default.
 */
function token() {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: 'ES256', kid: keyId, typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(
    JSON.stringify({ iss: issuerId, iat: now, exp: now + 600, aud: 'appstoreconnect-v1' })
  ).toString('base64url');
  const signature = createSign('SHA256')
    .sign({ key: privateKey, dsaEncoding: 'ieee-p1363' }, `${header}.${payload}`)
    .toString('base64url');
  return `${header}.${payload}.${signature}`;
}

async function api(path) {
  const res = await fetch(`${API}${path}`, { headers: { Authorization: `Bearer ${token()}` } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = (body.errors || []).map((e) => e.detail || e.title).join('; ') || res.statusText;
    throw new Error(`${res.status} ${detail}`);
  }
  return body;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let appId;
try {
  const apps = await api(`/v1/apps?filter[bundleId]=${encodeURIComponent(bundleId)}&limit=1`);
  appId = apps.data?.[0]?.id;
} catch (err) {
  console.error(`testflight: could not read the app record for ${bundleId}: ${err.message}`);
  process.exit(1);
}
if (!appId) {
  console.error(`testflight: no app record for ${bundleId}. Create it once in App Store Connect (Apps -> + -> New App).`);
  process.exit(1);
}

console.log(`testflight: ${bundleId} is app ${appId}; waiting on build ${buildNumber}`);

for (;;) {
  let build;
  try {
    const builds = await api(
      `/v1/builds?filter[app]=${appId}&filter[version]=${encodeURIComponent(buildNumber)}&limit=1`
    );
    build = builds.data?.[0];
  } catch (err) {
    console.error(`testflight: could not read builds: ${err.message}`);
    process.exit(1);
  }

  if (build) {
    const { processingState, version, uploadedDate } = build.attributes || {};
    if (processingState === 'VALID') {
      console.log(`testflight: build ${buildNumber} (${version}) is VALID — uploaded ${uploadedDate}, ready to install from TestFlight.`);
      process.exit(0);
    }
    if (processingState === 'INVALID' || processingState === 'FAILED') {
      console.error(`testflight: Apple rejected build ${buildNumber}: processingState=${processingState}.`);
      process.exit(1);
    }
    console.log(`testflight: build ${buildNumber} is ${processingState} (uploaded ${uploadedDate})`);
  } else {
    console.log(`testflight: build ${buildNumber} has not appeared yet`);
  }

  if (Date.now() + intervalMs > deadline) {
    console.log('::warning::The build was uploaded but had not finished processing when this job ran out of time. Check App Store Connect -> TestFlight.');
    process.exit(0);
  }
  await sleep(intervalMs);
}
