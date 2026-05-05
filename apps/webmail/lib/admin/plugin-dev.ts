import { readFile, readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { logger } from '@/lib/logger';
import type { ServerPlugin } from './plugin-registry';

/**
 * Dev-mode plugin loading.
 *
 * When the `PLUGIN_DEV_DIR` env var points at a directory, every immediate
 * subfolder is treated as a candidate plugin and merged into the registry
 * served to clients.
 *
 *   PLUGIN_DEV_DIR=/path/to/repos/plugins
 *
 * Each subfolder must contain `manifest.json` and the entrypoint file. If a
 * `dist/` subdirectory exists with its own `manifest.json` (typical for
 * plugins built via esbuild) we use that instead — so no extra copy step is
 * needed during development.
 *
 * Dev plugins always win on id collision with admin-installed plugins, the
 * bundle is served with `Cache-Control: no-store`, and the bundle hash is
 * recomputed on every request so that any save propagates to all connected
 * clients on their next page refresh.
 */

export interface DevPluginEntry {
  plugin: ServerPlugin;
  bundlePath: string;
  manifestPath: string;
}

const PLUGIN_ID_RE = /^[a-z0-9][a-z0-9-]*[a-z0-9]$/;

export function getPluginDevDir(): string | null {
  const dir = process.env.PLUGIN_DEV_DIR;
  if (!dir) return null;
  const resolved = path.resolve(dir);
  if (!existsSync(resolved)) {
    logger.warn(`PLUGIN_DEV_DIR is set but does not exist: ${resolved}`);
    return null;
  }
  return resolved;
}

function asString(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback;
}

async function readManifest(manifestPath: string): Promise<Record<string, unknown> | null> {
  try {
    const raw = await readFile(manifestPath, 'utf-8');
    const parsed = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null ? parsed : null;
  } catch {
    return null;
  }
}

async function loadDevPlugin(pluginDir: string): Promise<DevPluginEntry | null> {
  // Prefer dist/ when present (bundled output) so devs don't have to copy
  // manifest.json around.
  const distDir = path.join(pluginDir, 'dist');
  let manifestPath = path.join(distDir, 'manifest.json');
  let baseDir = distDir;
  if (!existsSync(manifestPath)) {
    manifestPath = path.join(pluginDir, 'manifest.json');
    baseDir = pluginDir;
  }
  if (!existsSync(manifestPath)) return null;

  const manifest = await readManifest(manifestPath);
  if (!manifest) return null;
  const id = asString(manifest.id);
  if (!PLUGIN_ID_RE.test(id)) return null;

  const entrypoint = asString(manifest.entrypoint, 'index.js');
  const bundlePath = path.join(baseDir, entrypoint);
  if (!existsSync(bundlePath)) return null;

  let bundleHash: string;
  try {
    const code = await readFile(bundlePath);
    bundleHash = createHash('sha256').update(code).digest('hex').slice(0, 16);
  } catch {
    return null;
  }

  let installedAt = new Date().toISOString();
  try {
    const stats = await stat(bundlePath);
    installedAt = stats.mtime.toISOString();
  } catch {
    /* ignore */
  }

  const permissions = Array.isArray(manifest.permissions)
    ? manifest.permissions.filter((p): p is string => typeof p === 'string')
    : [];

  const plugin: ServerPlugin = {
    id,
    name: asString(manifest.name, id),
    version: asString(manifest.version, '0.0.0-dev'),
    author: asString(manifest.author),
    description: asString(manifest.description),
    type: asString(manifest.type, 'hook'),
    permissions,
    entrypoint,
    enabled: true,
    forceEnabled: false,
    ...(manifest.configSchema && typeof manifest.configSchema === 'object'
      ? { configSchema: manifest.configSchema as ServerPlugin['configSchema'] }
      : {}),
    installedAt,
    updatedAt: new Date().toISOString(),
    bundleHash,
  };
  return { plugin, bundlePath, manifestPath };
}

export async function listDevPlugins(): Promise<DevPluginEntry[]> {
  const dir = getPluginDevDir();
  if (!dir) return [];

  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (error) {
    logger.warn('Failed to read PLUGIN_DEV_DIR', {
      dir,
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }

  const out: DevPluginEntry[] = [];
  for (const name of entries) {
    if (name.startsWith('.') || name === 'node_modules') continue;
    const fullPath = path.join(dir, name);
    let isDir = false;
    try { isDir = (await stat(fullPath)).isDirectory(); } catch { continue; }
    if (!isDir) continue;

    const entry = await loadDevPlugin(fullPath);
    if (entry) out.push(entry);
  }
  return out;
}

export async function getDevPlugin(id: string): Promise<DevPluginEntry | null> {
  if (!PLUGIN_ID_RE.test(id)) return null;
  const list = await listDevPlugins();
  return list.find(e => e.plugin.id === id) ?? null;
}
