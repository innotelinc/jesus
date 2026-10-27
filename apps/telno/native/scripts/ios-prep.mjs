/**
 * Turn a freshly generated Capacitor iOS project into SCIF.
 *
 * `npx cap add ios` writes a template with an empty App target. Everything this
 * app actually needs — the four Swift plugins, the background modes, the usage
 * strings, the push entitlement, the one line in AppDelegate — lives in this
 * repository as plain files, because a `.xcodeproj` is a binary-ish artifact
 * nobody can review in a diff. This script applies them, so the project is
 * reproducible instead of a set of "then in Xcode, click…" steps.
 *
 *   node scripts/ios-prep.mjs
 *
 * It runs on macOS (CI does it on a macOS runner; a developer runs it after
 * `cap add ios`) and deliberately needs nothing but `plutil`, which ships with
 * the OS. Re-running it is safe: every step is idempotent.
 */
import { copyFileSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { basename, join, resolve } from 'node:path';

const here = resolve(import.meta.dirname, '..');
// The wrapper's own files, and the generated project they are applied to. They
// are separate directories on purpose: a checked-in `ios/` would stop
// `npx cap add ios` from generating one, and a generated project is a file tree
// nobody should be reviewing in a diff.
const source = join(here, 'scif');
const project = join(here, 'ios/App/App');
const appDelegate = join(project, 'AppDelegate.swift');
const infoPlist = join(project, 'Info.plist');

const done = [];
const fail = (message) => {
  console.error(`ios-prep: ${message}`);
  process.exit(1);
};

const plist = (args) => execFileSync('plutil', args, { encoding: 'utf8' });
const readPlistJson = (file) => JSON.parse(plist(['-convert', 'json', '-o', '-', file]));

/** Deep merge, with the additions winning: they are the app's own settings. */
function merge(target, additions) {
  for (const [key, value] of Object.entries(additions)) {
    const existing = target[key];
    if (value && typeof value === 'object' && !Array.isArray(value) && existing && typeof existing === 'object') {
      merge(existing, value);
    } else {
      target[key] = value;
    }
  }
  return target;
}

if (!existsSync(infoPlist)) {
  fail(`no generated project at ${project} — run "npx cap add ios" first`);
}

/* The plugins. `cap sync` never copies files into the Xcode target: they are
   added to the project by scripts/ios-project.rb. */
const plugins = ['ScifCallManager.swift', 'ScifCallPlugin.swift', 'ScifSpeechPlugin.swift', 'ScifBiometricsPlugin.swift'];
for (const file of plugins) {
  if (!existsSync(join(source, file))) fail(`${file} is missing from ios/App/App`);
  copyFileSync(join(source, file), join(project, file));
}
done.push(`${plugins.length} Swift plugins`);

/* Info.plist. Read as JSON, merged, written back as XML, so we never hand-edit
   the template's own keys and never lose them either. */
const additions = readPlistJson(join(source, 'Info.additions.plist'));
const target = readPlistJson(infoPlist);
const merged = merge(target, additions);
const scratch = join(project, 'Info.merged.plist');
writeFileSync(scratch, JSON.stringify(merged, null, 2));
plist(['-convert', 'xml1', '-o', infoPlist, scratch]);
rmSync(scratch, { force: true });
done.push(`Info.plist keys merged (${Object.keys(additions).join(', ')})`);

/* The push entitlement. TestFlight and the App Store need "production"; a
   development build talking to the sandbox needs "development". */
const entitlements = join(project, 'App.entitlements');
copyFileSync(join(source, 'App.entitlements'), entitlements);
const environment = process.env.SCIF_APS_ENVIRONMENT || 'production';
let entitlementXml = readFileSync(entitlements, 'utf8');
if (/<key>aps-environment<\/key>\s*<string>[^<]*<\/string>/.test(entitlementXml)) {
  entitlementXml = entitlementXml.replace(
    /(<key>aps-environment<\/key>\s*<string>)[^<]*(<\/string>)/,
    `$1${environment}$2`
  );
} else {
  entitlementXml = entitlementXml.replace('</dict>', `\t<key>aps-environment</key>\n\t<string>${environment}</string>\n</dict>`);
}
writeFileSync(entitlements, entitlementXml);
done.push(`aps-environment = ${environment}`);

/* PushKit only fires if the manager starts, and it has to start in
   didFinishLaunching: a VoIP push that arrives before it does is dropped. */
if (existsSync(appDelegate)) {
  const swift = readFileSync(appDelegate, 'utf8');
  if (!swift.includes('ScifCallManager.shared.start()')) {
    const patched = swift.replace(
      /(func application\(_ application: UIApplication,\s*didFinishLaunchingWithOptions launchOptions: \[UIApplication\.LaunchOptionsKey: Any\]\?\) -> Bool\s*\{\n)/,
      '$1        ScifCallManager.shared.start()\n'
    );
    if (patched === swift) fail(`could not find didFinishLaunchingWithOptions in ${basename(appDelegate)}`);
    writeFileSync(appDelegate, patched);
    done.push('AppDelegate starts the call manager');
  } else {
    done.push('AppDelegate already starts the call manager');
  }
} else {
  fail(`no ${basename(appDelegate)} — did "npx cap add ios" finish?`);
}

console.log(`ios-prep: ${done.join('; ')}`);
