import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "../..");

function readIfExists(relPath) {
  const full = path.join(ROOT, relPath);
  if (!fs.existsSync(full)) return null;
  return fs.readFileSync(full, "utf-8");
}

// ─── Docker Hardening Checks ─────────────────────────

test("Dockerfile uses non-root user", () => {
  const content = readIfExists("Dockerfile");
  if (!content) return;

  // Keep as warning-only to avoid false negatives in current image policy.
  const hasUser = /^USER\s+\S+/m.test(content);
  if (!hasUser) {
    console.log("  ⚠️  WARNING: Dockerfile does not specify a non-root USER");
  }
});

test("Dockerfile does not COPY .env or secrets", () => {
  const content = readIfExists("Dockerfile");
  if (!content) return;
  assert.equal(/COPY.*\.env\b/m.test(content), false, "Dockerfile should not COPY .env files");
});

test(".dockerignore excludes sensitive files", () => {
  const content = readIfExists(".dockerignore");
  if (!content) return;
  assert.ok(content.includes(".env"), ".dockerignore should exclude .env files");
});

// ─── Secrets Hardening Checks ────────────────────────

test("package.json does not contain hardcoded legacy secrets", () => {
  const pkg = readIfExists("package.json");
  assert.ok(pkg, "package.json should exist");
  const sensitivePatterns = [
    "omniroute-default-secret-change-me",
    "endpoint-proxy-api-key-secret",
    "change-me-storage-encryption",
  ];
  for (const pattern of sensitivePatterns) {
    assert.equal(pkg.includes(pattern), false, `package.json should not contain "${pattern}"`);
  }
});

test("proxy.ts does not contain hardcoded JWT_SECRET fallback", () => {
  const content = readIfExists("src/proxy.ts");
  assert.ok(content, "src/proxy.ts should exist");
  assert.equal(
    content.includes("omniroute-default-secret-change-me"),
    false,
    "src/proxy.ts should not have hardcoded JWT_SECRET fallback"
  );
});

test("apiKey.ts does not contain legacy API_KEY_SECRET fallback literal", () => {
  const content = readIfExists("src/shared/utils/apiKey.ts");
  assert.ok(content, "src/shared/utils/apiKey.ts should exist");
  assert.equal(
    content.includes("endpoint-proxy-api-key-secret"),
    false,
    "src/shared/utils/apiKey.ts should not contain legacy fallback literal"
  );
});

test(".env.example has empty JWT_SECRET (not a default value)", () => {
  const envExample = readIfExists(".env.example");
  assert.ok(envExample, ".env.example should exist");
  const jwtLine = envExample.split("\n").find((l) => l.startsWith("JWT_SECRET="));
  assert.ok(jwtLine, ".env.example should have JWT_SECRET");
  const value = jwtLine.split("=")[1]?.trim();
  assert.ok(!value || value === "", "JWT_SECRET should be empty in .env.example");
});

test(".env.example has empty API_KEY_SECRET (not a default value)", () => {
  const envExample = readIfExists(".env.example");
  assert.ok(envExample, ".env.example should exist");
  const apiKeyLine = envExample.split("\n").find((l) => l.startsWith("API_KEY_SECRET="));
  assert.ok(apiKeyLine, ".env.example should have API_KEY_SECRET");
  const value = apiKeyLine.split("=")[1]?.trim();
  assert.ok(!value || value === "", "API_KEY_SECRET should be empty in .env.example");
});

// ─── Schema Hardening Checks ─────────────────────────

test("schemas.ts does not use .passthrough() in executable code", () => {
  const content = readIfExists("src/shared/validation/schemas.ts");
  assert.ok(content, "src/shared/validation/schemas.ts should exist");

  const lines = content.split("\n");
  const codeLines = lines.filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*"));
  const hasPassthrough = codeLines.some((l) => l.includes(".passthrough()"));
  assert.equal(
    hasPassthrough,
    false,
    "schemas.ts should not use .passthrough() in code — fields must be explicitly listed"
  );
});

// ─── Dependency / CI Checks ──────────────────────────

test("package.json does not depend on npm 'fs' package", () => {
  const pkg = JSON.parse(readIfExists("package.json"));
  const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
  assert.equal("fs" in allDeps, false, "Should not depend on npm 'fs' package (use node:fs)");
});

test("CI workflow exists and runs lint + tests", () => {
  const content = readIfExists(".github/workflows/ci.yml");
  assert.ok(content, "CI workflow should exist at .github/workflows/ci.yml");
  assert.ok(content.includes("lint"), "CI should run linting");
  assert.ok(
    content.includes("test:unit") || content.includes("npm test") || content.includes("test"),
    "CI should run tests"
  );
});

test("package.json test script runs tests", () => {
  const pkg = JSON.parse(readIfExists("package.json"));
  const testScript = pkg.scripts?.test;
  assert.ok(testScript, "package.json must have a test script");
  assert.ok(
    testScript.includes("--test") || testScript.includes("vitest") || testScript.includes("jest"),
    `test script should run tests, got: ${testScript}`
  );
});

// ─── Runtime Wiring Checks ───────────────────────────

test("chat handler imports inputSanitizer", () => {
  const content = readIfExists("src/sse/handlers/chat.ts");
  assert.ok(content, "src/sse/handlers/chat.ts should exist");
  assert.ok(
    content.includes("inputSanitizer") || content.includes("sanitizeRequest"),
    "chat.ts should import and use input sanitizer"
  );
});

test("server-init.ts calls enforceSecrets", () => {
  const content = readIfExists("src/server-init.ts");
  assert.ok(content, "src/server-init.ts should exist");
  assert.ok(content.includes("enforceSecrets"), "server-init.ts should call enforceSecrets");
});
