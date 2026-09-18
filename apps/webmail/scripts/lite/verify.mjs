#!/usr/bin/env node
// Guards for a finished Lite export: the files a deployer relies on exist,
// and the client chunks reference no server endpoint outside the documented
// allowlist (lib.mjs). Exit 1 with a readable list otherwise.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  LITE_PENDING_PATH_KEY, collectApiStrings, discoverBuiltLocales, isMainModule, resolveRepoRoot, unexpectedApiStrings,
} from "./lib.mjs";

const repoRoot = resolveRepoRoot(import.meta.url);

export function verifyExport({ root = repoRoot } = {}) {
  const outDir = join(root, "out");
  const problems = [];

  const locales = discoverBuiltLocales(outDir);
  if (locales.length === 0) problems.push("no locale shells found (out/<locale>/mail/index.html)");

  for (const locale of locales) {
    for (const surface of ["mail", "calendar", "contacts", "files", "settings", "login"]) {
      if (!existsSync(join(outDir, locale, surface, "index.html"))) problems.push(`missing out/${locale}/${surface}/index.html`);
    }
    if (!existsSync(join(outDir, locale, "index.html"))) problems.push(`missing out/${locale}/index.html`);
  }

  for (const file of ["index.html", "404.html", "config.json", "policy.json", "manifest.webmanifest", "_redirects", "_headers", "LITE-README.md", "lite-build.json"]) {
    if (!existsSync(join(outDir, file))) problems.push(`missing out/${file}`);
  }
  for (const file of ["_next/static", "branding"]) {
    if (!existsSync(join(outDir, file))) problems.push(`missing out/${file}`);
  }

  // Next writes its own default not-found page as 404.html; postbuild must
  // have replaced it with the shim that parks and replays deep links.
  const notFound = join(outDir, "404.html");
  if (existsSync(notFound) && !readFileSync(notFound, "utf8").includes(LITE_PENDING_PATH_KEY)) {
    problems.push("out/404.html is not the Lite shim (deep links on hosts without rewrites would dead-end); run postbuild");
  }

  const apiStrings = collectApiStrings(join(outDir, "_next", "static"));
  const unexpected = unexpectedApiStrings(apiStrings);
  for (const s of unexpected) problems.push(`client chunk references undocumented server endpoint ${s} (add an IS_LITE gate or document it in scripts/lite/lib.mjs)`);

  return { problems, locales, apiStrings };
}

if (isMainModule(import.meta.url)) {
  const { problems, locales, apiStrings } = verifyExport();
  if (problems.length > 0) {
    console.error(`[lite] verification failed (${problems.length} problems):`);
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }
  console.log(`[lite] export verified: ${locales.length} locales, ${apiStrings.length} known /api strings in chunks`);
}
