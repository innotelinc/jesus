import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  LITE_API_STRING_ALLOWLIST,
  LITE_PENDING_PATH_KEY,
  LOCALE_STORAGE_KEY,
  buildCaddyExample,
  buildHeaders,
  buildLiteConfig,
  buildLitePolicy,
  buildManifest,
  buildNginxExample,
  buildNotFoundShim,
  buildReadme,
  buildRedirects,
  buildRootRedirect,
  collectApiStrings,
  discoverBuiltLocales,
  normalizeBasePath,
  parseBool,
  unexpectedApiStrings,
} from '../../scripts/lite/lib.mjs';
import { collectTestPaths, planRemovals, runPrepare } from '../../scripts/lite/prepare.mjs';
import { runPostbuild } from '../../scripts/lite/postbuild.mjs';
import { verifyExport } from '../../scripts/lite/verify.mjs';
import { LITE_PENDING_PATH_KEY as APP_LITE_PENDING_PATH_KEY } from '../lite';

/** The scripts take `process.env`-shaped input; tests pass plain objects. */
function env(values: Record<string, string> = {}): NodeJS.ProcessEnv {
  return values as NodeJS.ProcessEnv;
}

function makeRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'bulwark-lite-'));
  const touch = (rel: string, content = '') => {
    const full = join(root, ...rel.split('/'));
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, content);
  };
  touch('proxy.ts');
  touch('app/api/config/route.ts');
  touch('app/(main)/admin/page.tsx');
  touch('app/(main)/[locale]/mail/[[...segments]]/page.tsx');
  touch('lib/__tests__/foo.test.ts');
  touch('lib/keep.ts');
  touch('stores/bar.test.tsx');
  touch('scripts/lite/lib.mjs');
  touch('scripts/lite/smoke/lite.spec.ts');
  touch('node_modules/pkg/x.test.js');
  touch('repos/other/y.test.ts');
  touch('VERSION', '1.10.0\n');
  return root;
}

describe('lite build helpers', () => {
  it('parses booleans and base paths', () => {
    expect(parseBool('true')).toBe(true);
    expect(parseBool('1')).toBe(true);
    expect(parseBool('no')).toBe(false);
    expect(parseBool(undefined, true)).toBe(true);
    expect(normalizeBasePath('/webmail/')).toBe('/webmail');
    expect(normalizeBasePath('')).toBe('');
    expect(() => normalizeBasePath('webmail')).toThrow(/start with/);
  });

  it('derives config.json from the LITE_* inputs with safe defaults', () => {
    const empty = buildLiteConfig({});
    expect(empty.jmapServerUrl).toBe('');
    expect(empty.allowCustomJmapEndpoint).toBe(true);
    expect(empty.rememberMeEnabled).toBe(true);
    expect(empty.demoMode).toBe(false);
    expect(empty.appName).toBe('Bulwark Webmail');

    const fixed = buildLiteConfig({ LITE_JMAP_SERVER_URL: 'https://mail.example.com/', LITE_APP_NAME: 'Acme', LITE_DEMO_MODE: 'true', LITE_REMEMBER_ME: 'false' });
    expect(fixed.jmapServerUrl).toBe('https://mail.example.com');
    expect(fixed.allowCustomJmapEndpoint).toBe(false);
    expect(fixed.appName).toBe('Acme');
    expect(fixed.demoMode).toBe(true);
    expect(fixed.rememberMeEnabled).toBe(false);
    expect(buildLitePolicy().features).toEqual({ pluginsEnabled: false, sidebarAppsEnabled: false });
  });

  it('prefixes manifest and redirect paths with the base path', () => {
    const manifest = buildManifest({ appName: 'Acme', basePath: '/webmail' });
    expect(manifest.start_url).toBe('/webmail/');
    expect(manifest.icons[0].src).toBe('/webmail/icon-192x192.png');

    const redirects = buildRedirects({ basePath: '/webmail', locales: ['en', 'de'] });
    expect(redirects).toContain('/webmail/en/mail/*  /webmail/en/mail/index.html  200');
    expect(redirects).toContain('/webmail/de/settings/*  /webmail/de/settings/index.html  200');
    expect(redirects).not.toContain('/en/login/*');
  });

  it('writes a root shim that knows every built locale and the fallback', () => {
    const html = buildRootRedirect({ basePath: '/webmail', locales: ['de', 'en', 'zh-TW'], defaultLocale: 'en' });
    expect(html).toContain('var locales = ["de","en","zh-TW"]');
    expect(html).toContain('var fallback = "en"');
    expect(html).toContain('var base = "/webmail"');
    expect(html).toContain('href="/webmail/en/"');
    // The language picked in Settings (zustand persist key of stores/locale-store.ts) wins.
    expect(html).toContain(`localStorage.getItem("${LOCALE_STORAGE_KEY}")`);
    expect(LOCALE_STORAGE_KEY).toBe('locale-storage');
    // An unknown default falls back to the first built locale.
    expect(buildRootRedirect({ locales: ['de'], defaultLocale: 'fr' })).toContain('var fallback = "de"');
  });

  it('emits a CSP that allows inline scripts and the configured server only', () => {
    const headers = buildHeaders({ basePath: '', connectSrc: 'https://mail.example.com' });
    expect(headers).toContain("script-src 'self' 'unsafe-inline'");
    expect(headers).toContain("connect-src 'self' https://mail.example.com");
    expect(headers).toContain("frame-ancestors 'none'");
    expect(headers).toContain('/_next/static/*');
    expect(buildHeaders({ basePath: '/w', connectSrc: '*' })).toMatch(/^\/w\/\*/);
  });

  it('writes a 404 shim that parks deep links for known locale/surface pairs only', () => {
    const html = buildNotFoundShim({ basePath: '/webmail', locales: ['de', 'en'] });
    expect(html).toContain('var base = "/webmail"');
    expect(html).toContain('var locales = ["de","en"]');
    expect(html).toContain('var surfaces = ["mail","calendar","contacts","files","settings"]');
    expect(html).toContain(`sessionStorage.setItem("${LITE_PENDING_PATH_KEY}"`);
    // Only allowlisted segments are ever assembled into the redirect target.
    expect(html).toContain('var target = base + "/" + parts[0] + "/" + parts[1] + "/"');
    expect(html).toContain('location.replace(target)');
    expect(html).toContain('href="/webmail/"');
    // The key the shim writes is the one the app reads.
    expect(LITE_PENDING_PATH_KEY).toBe(APP_LITE_PENDING_PATH_KEY);
  });

  it('renders host snippets and the README for the built variant', () => {
    expect(buildNginxExample({ basePath: '' })).toContain('(?<surface>mail|calendar|contacts|files|settings)');
    // Root-relative everywhere: a sub-path mount means the files live in <root><basePath>
    // (alias does not work inside a regex location and produced a redirect cycle).
    const nginxSub = buildNginxExample({ basePath: '/w' });
    expect(nginxSub).not.toContain('alias ');
    expect(nginxSub).toContain('Unzip the archive into /var/www/bulwark-lite/w');
    expect(nginxSub).toContain('try_files $uri $uri/ $uri/index.html /w/$locale/$surface/index.html');
    expect(nginxSub).toContain('error_page 404 /w/404.html');
    expect(nginxSub).toContain('default_type application/manifest+json');
    expect(buildCaddyExample({ basePath: '' })).toContain('try_files {path} {path}/ {path}/index.html /{re.surface.1}/{re.surface.2}/index.html');
    expect(buildCaddyExample({ basePath: '/w' })).toContain('rewrite @notfound /w/404.html');
    expect(buildReadme({ version: '1.10.0', commit: 'abc1234', basePath: '/w', locales: ['en'] })).toContain('unzip into `<web root>/w`');
    const readme = buildReadme({ version: '1.10.0', commit: 'abc1234', basePath: '/w', locales: ['en'], jmapServerUrl: 'https://m.example', demoMode: true });
    expect(readme).toContain('# Bulwark Lite 1.10.0 (abc1234)');
    expect(readme).toContain('Demo mode is ON');
    expect(readme).toContain('permissive-cors = true');
    expect(readme).toContain('currently `https://m.example`');
  });

  it('flags server endpoints outside the documented allowlist', () => {
    expect(unexpectedApiStrings(['/api/config', '/api/plugins/x', '/api/push/register/web'])).toEqual([]);
    expect(unexpectedApiStrings(['/api/brand-new-thing', '/api/config'])).toEqual(['/api/brand-new-thing']);
    expect(LITE_API_STRING_ALLOWLIST).toContain('/api/config');
  });
});

describe('prepare / postbuild / verify against a fake checkout', () => {
  it('plans the server-only trees and every test file, skipping node_modules, repos and scripts', () => {
    const root = makeRepo();
    try {
      const tests = collectTestPaths(root).map((p) => p.slice(root.length + 1).replace(/\\/g, '/'));
      expect(tests.sort()).toEqual(['lib/__tests__', 'stores/bar.test.tsx']);
      const plan = planRemovals(root).map((p) => p.slice(root.length + 1).replace(/\\/g, '/'));
      expect(plan).toContain('proxy.ts');
      expect(plan).toContain('app/api');
      expect(plan).toContain('app/(main)/admin');
      expect(plan).not.toContain('app/(main)/[locale]/mail/[[...segments]]/page.tsx');
      expect(plan).not.toContain('scripts/lite/smoke/lite.spec.ts');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses to delete outside CI unless --in-place is given, and --dry-run never deletes', () => {
    const root = makeRepo();
    try {
      const log = () => {};
      expect(() => runPrepare({ root, argv: [], env: env(), log })).toThrow(/refusing/);
      runPrepare({ root, argv: ['--dry-run'], env: env(), log });
      expect(existsSync(join(root, 'proxy.ts'))).toBe(true);

      const result = runPrepare({ root, argv: ['--in-place'], env: env(), log });
      expect(result.removed.length).toBeGreaterThan(0);
      expect(existsSync(join(root, 'proxy.ts'))).toBe(false);
      expect(existsSync(join(root, 'app', 'api'))).toBe(false);
      expect(existsSync(join(root, 'lib', '__tests__'))).toBe(false);
      expect(existsSync(join(root, 'lib', 'keep.ts'))).toBe(true);
      expect(existsSync(join(root, 'scripts', 'lite', 'smoke', 'lite.spec.ts'))).toBe(true);
      expect(existsSync(join(root, 'node_modules', 'pkg', 'x.test.js'))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('CI=true counts as consent', () => {
    const root = makeRepo();
    try {
      runPrepare({ root, argv: [], env: env({ CI: 'true' }), log: () => {} });
      expect(existsSync(join(root, 'proxy.ts'))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('postbuild writes the deployer files for the built locales and verify accepts the result', () => {
    const root = makeRepo();
    try {
      const out = join(root, 'out');
      for (const locale of ['en', 'de']) {
        for (const surface of ['mail', 'calendar', 'contacts', 'files', 'settings', 'login']) {
          mkdirSync(join(out, locale, surface), { recursive: true });
          writeFileSync(join(out, locale, surface, 'index.html'), '<html></html>');
        }
        writeFileSync(join(out, locale, 'index.html'), '<html></html>');
      }
      mkdirSync(join(out, '_next', 'static', 'chunks'), { recursive: true });
      writeFileSync(join(out, '_next', 'static', 'chunks', 'app.js'), 'fetch("/api/config");fetch(`/api/plugins`);');
      mkdirSync(join(out, 'branding'), { recursive: true });
      writeFileSync(join(out, '404.html'), '<html></html>');

      expect(discoverBuiltLocales(out)).toEqual(['de', 'en']);

      const result = runPostbuild({
        root,
        env: env({ LITE_JMAP_SERVER_URL: 'https://mail.example.com', LITE_APP_NAME: 'Acme', NEXT_PUBLIC_BASE_PATH: '/w', GIT_COMMIT: 'abcdef1234567' }),
        log: () => {},
      });
      expect(result.locales).toEqual(['de', 'en']);
      expect(result.basePath).toBe('/w');
      for (const file of ['config.json', 'policy.json', 'manifest.webmanifest', 'index.html', '_redirects', '_headers', 'nginx.conf.example', 'Caddyfile.example', 'LITE-README.md', 'lite-build.json']) {
        expect(existsSync(join(out, file)), file).toBe(true);
      }
      expect(collectApiStrings(join(out, '_next', 'static'))).toEqual(['/api/config', '/api/plugins']);
      // Next's default not-found page was replaced by the park-and-replay shim.
      expect(readFileSync(join(out, '404.html'), 'utf8')).toContain(LITE_PENDING_PATH_KEY);

      const verdict = verifyExport({ root });
      expect(verdict.problems).toEqual([]);
      expect(verdict.locales).toEqual(['de', 'en']);

      // An export whose 404.html is still Next's default fails verification.
      writeFileSync(join(out, '404.html'), '<html>404: This page could not be found.</html>');
      expect(verifyExport({ root }).problems.join('\n')).toContain('404.html is not the Lite shim');
      writeFileSync(join(out, '404.html'), buildNotFoundShim({ basePath: '/w', locales: ['de', 'en'] }));

      // A new, undocumented endpoint in a chunk is a verification failure.
      writeFileSync(join(out, '_next', 'static', 'chunks', 'new.js'), 'apiFetch("/api/brand-new")');
      expect(verifyExport({ root }).problems.join('\n')).toContain('/api/brand-new');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('verify lists what is missing from an incomplete export', () => {
    const root = makeRepo();
    try {
      mkdirSync(join(root, 'out'), { recursive: true });
      const { problems } = verifyExport({ root });
      expect(problems).toContain('no locale shells found (out/<locale>/mail/index.html)');
      expect(problems).toContain('missing out/config.json');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
