#!/usr/bin/env node
// Dependency-free static server for a Lite export, applying the same SPA
// fallback the shipped nginx/Caddy snippets do. Used by the Playwright smoke
// test and handy for a local look at out/:
//
//   node scripts/lite/serve.mjs [outDir=out] [port=4173] [basePath=] [--plain]
//
// `--plain` switches the SPA fallback off and answers unknown paths with
// 404.html (status 404), the way GitHub Pages or an S3 bucket would; that is
// the path the 404 shim's park-and-replay exists for.
import { createServer } from "node:http";
import { createReadStream, existsSync, statSync } from "node:fs";
import { extname, join, normalize, resolve } from "node:path";
import { LITE_SURFACES } from "./lib.mjs";

const flags = process.argv.slice(2).filter((a) => a.startsWith("--"));
const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const plain = flags.includes("--plain");
const root = resolve(args[0] || "out");
const port = Number(args[1] || 4173);
const basePath = (args[2] || "").replace(/\/+$/, "");

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".map": "application/json",
};

function send(res, file, status = 200) {
  res.writeHead(status, { "content-type": TYPES[extname(file)] || "application/octet-stream" });
  createReadStream(file).pipe(res);
}

function fileFor(pathname) {
  const rel = normalize(decodeURIComponent(pathname)).replace(/^[/\\]+/, "");
  const direct = join(root, rel);
  if (!direct.startsWith(root)) return null;
  if (existsSync(direct) && statSync(direct).isFile()) return direct;
  const index = join(direct, "index.html");
  if (existsSync(index)) return index;
  const html = `${direct}.html`;
  if (existsSync(html)) return html;
  return null;
}

const surfacePattern = new RegExp(`^/([^/]+)/(${LITE_SURFACES.join("|")})(?:/|$)`);

export function resolveRequest(pathname) {
  if (basePath) {
    if (pathname !== basePath && !pathname.startsWith(`${basePath}/`)) return { status: 404, file: join(root, "404.html") };
    pathname = pathname.slice(basePath.length) || "/";
  }
  const file = fileFor(pathname);
  if (file) return { status: 200, file };
  const match = plain ? null : pathname.match(surfacePattern);
  if (match) {
    const shell = join(root, match[1], match[2], "index.html");
    if (existsSync(shell)) return { status: 200, file: shell };
  }
  return { status: 404, file: join(root, "404.html") };
}

createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  const { status, file } = resolveRequest(url.pathname);
  if (file && existsSync(file)) return send(res, file, status);
  res.writeHead(404, { "content-type": "text/plain" });
  res.end("not found");
}).listen(port, () => {
  console.log(`[lite] serving ${root} at http://localhost:${port}${basePath}/${plain ? " (plain: no SPA fallback, 404.html for unknown paths)" : ""}`);
});
