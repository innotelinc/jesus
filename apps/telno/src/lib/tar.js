import { createReadStream, createWriteStream, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, posix, sep } from 'node:path';
import { Readable } from 'node:stream';
import { createGunzip, createGzip } from 'node:zlib';
import { pipeline } from 'node:stream/promises';

/**
 * A tar reader and writer, and nothing else.
 *
 * Backups need one archive format, and `tar` on the host is not always there to
 * provide it: a Windows development machine has one binary, a slim container
 * image has another, and "works here, not there" is how a backup path stops
 * being trusted. This is the ustar subset that matters — regular files and
 * directories — written and read by this process, with gzip from `node:zlib`.
 *
 * Deliberately absent: symlinks, hard links, sparse files, device nodes,
 * xattrs, PAX extensions. A backup of this platform is a database, a JSON
 * manifest and audio files; anything else in the tree is skipped rather than
 * half-supported.
 */

const BLOCK = 512;
const EMPTY = Buffer.alloc(BLOCK);

/** Octal, NUL-terminated, in the width tar wants. */
const octal = (value, length) => `${Math.max(0, value).toString(8).padStart(length - 1, '0')}\0`;

/** A 100-byte name, or a split across name/prefix for a longer path. */
function nameField(arcname) {
  const name = Buffer.alloc(100);
  const prefix = Buffer.alloc(155);
  const bytes = Buffer.from(arcname, 'utf8');
  if (bytes.length <= 100) {
    bytes.copy(name);
    return { name, prefix };
  }
  const cut = arcname.lastIndexOf('/', 155);
  if (cut <= 0) throw new Error(`path too long for tar: ${arcname}`);
  Buffer.from(arcname.slice(cut + 1), 'utf8').copy(name);
  Buffer.from(arcname.slice(0, cut), 'utf8').copy(prefix);
  return { name, prefix };
}

function header({ arcname, size = 0, mode = 0o644, mtime = new Date(), type = '0' }) {
  const block = Buffer.alloc(BLOCK);
  const { name, prefix } = nameField(arcname);
  name.copy(block, 0);
  block.write(octal(mode, 8), 100);
  block.write(octal(0, 8), 108); // uid
  block.write(octal(0, 8), 116); // gid
  block.write(octal(size, 12), 124);
  block.write(octal(Math.floor(mtime.getTime() / 1000), 12), 136);
  block.write('        ', 148); // checksum placeholder: spaces
  block.write(type, 156);
  block.write('ustar\0', 257);
  block.write('00', 263);
  block.write('telno', 265); // uname
  block.write('telno', 297); // gname
  prefix.copy(block, 345);

  let sum = 0;
  for (const byte of block) sum += byte;
  block.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
  return block;
}

/** Parse one header block, or null for the end-of-archive marker. */
function parseHeader(block) {
  if (block.every((byte) => byte === 0)) return null;
  const str = (start, length) => block.subarray(start, start + length).toString('utf8').replace(/\0.*$/, '');
  const size = parseInt(str(124, 12).trim() || '0', 8);
  const type = str(156, 1) || '0';
  const prefix = str(345, 155);
  const name = str(0, 100);
  return { arcname: prefix ? `${prefix}/${name}` : name, size: Number.isFinite(size) ? size : 0, type };
}

/** Every regular file under `root`, as archive names relative to `prefix`. */
function walk(root, prefix, current = root) {
  const out = [];
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    const full = join(current, entry.name);
    const arc = posix.join(prefix, full.slice(root.length + 1).split(sep).join('/'));
    if (entry.isDirectory()) {
      out.push({ kind: 'dir', arcname: arc });
      out.push(...walk(root, prefix, full));
    } else if (entry.isFile()) {
      out.push({ kind: 'file', arcname: arc, path: full });
    }
    // Anything else (a socket, a symlink) is skipped on purpose: see above.
  }
  return out;
}

async function* streamTar(entries) {
  for (const entry of entries) {
    if (entry.kind === 'dir') {
      yield header({ arcname: `${entry.arcname}/`, type: '5', mode: 0o755 });
      continue;
    }
    const stats = (await import('node:fs')).statSync(entry.path);
    yield header({ arcname: entry.arcname, size: stats.size, mtime: stats.mtime });
    if (stats.size > 0) {
      const readable = createReadStream(entry.path);
      for await (const chunk of readable) yield chunk;
      const remainder = stats.size % BLOCK;
      if (remainder) yield Buffer.alloc(BLOCK - remainder);
    }
  }
  yield EMPTY;
  yield EMPTY;
}

/**
 * Write `sourceDir` into `archiveFile` as a single top-level directory.
 *
 *   packDirectory({ sourceDir: '/data/backups/telno-1', prefix: 'telno-1',
 *                   archiveFile: '/data/backups/telno-1.tar.gz' })
 */
export async function packDirectory({ sourceDir, archiveFile, prefix }) {
  const name = prefix || 'archive';
  const entries = [{ kind: 'dir', arcname: name }, ...walk(sourceDir, name)];
  await pipeline(Readable.from(streamTar(entries)), createGzip({ level: 6 }), createWriteStream(archiveFile));
  return { archiveFile, entries: entries.length };
}

/** Read the manifest out of an archive without writing anything to disk. */
export async function readFileFromArchive(archiveFile, wanted) {
  const source = createReadStream(archiveFile).pipe(createGunzip());
  let pending = Buffer.alloc(0);
  let current = null;
  let collected = Buffer.alloc(0);

  for await (const chunk of source) {
    pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
    while (pending.length >= BLOCK) {
      if (!current) {
        const head = parseHeader(pending.subarray(0, BLOCK));
        if (!head) return null;
        pending = pending.subarray(BLOCK);
        if (head.size === 0) continue;
        current = head;
        collected = Buffer.alloc(0);
      }
      const take = Math.min(current.size - collected.length, pending.length);
      collected = Buffer.concat([collected, pending.subarray(0, take)]);
      pending = pending.subarray(take);
      if (collected.length === current.size) {
        const name = current.arcname;
        current = null;
        if (name.endsWith(wanted)) return collected.toString('utf8');
      }
    }
  }
  return null;
}

/** Extract every entry into `destDir`. Returns the names written. */
export async function extractArchive({ archiveFile, destDir }) {
  const source = createReadStream(archiveFile).pipe(createGunzip());
  const written = [];
  let pending = Buffer.alloc(0);
  let current = null;
  let collected = Buffer.alloc(0);
  // Every entry is padded to a 512-byte boundary. Those padding bytes are not
  // part of any file, and reading them as the next header is how an archive
  // extracts its first entry correctly and then turns to noise.
  let skip = 0;

  const safe = (arcname) => {
    const clean = posix.normalize(arcname).replace(/^\/+/, '');
    if (clean.startsWith('..') || clean.includes('/../')) return null;
    return join(destDir, ...clean.split('/'));
  };

  for await (const chunk of source) {
    pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
    while (pending.length >= BLOCK) {
      if (skip > 0) {
        const consumed = Math.min(skip, pending.length);
        pending = pending.subarray(consumed);
        skip -= consumed;
        if (pending.length < BLOCK) break;
        continue;
      }
      if (!current) {
        const head = parseHeader(pending.subarray(0, BLOCK));
        if (!head) return written;
        pending = pending.subarray(BLOCK);
        if (head.size === 0) {
          if (head.type === '5' || head.arcname.endsWith('/')) {
            const dir = safe(head.arcname);
            if (dir) mkdirSync(dir, { recursive: true });
          }
          continue;
        }
        current = head;
        collected = Buffer.alloc(0);
        if (head.type === '5') {
          const dir = safe(head.arcname);
          if (dir) mkdirSync(dir, { recursive: true });
          current = null;
          continue;
        }
      }
      const take = Math.min(current.size - collected.length, pending.length);
      collected = Buffer.concat([collected, pending.subarray(0, take)]);
      pending = pending.subarray(take);
      if (collected.length === current.size) {
        const target = safe(current.arcname);
        if (target) {
          mkdirSync(dirname(target), { recursive: true });
          writeFileSync(target, collected);
          written.push(current.arcname);
        }
        skip = (BLOCK - (current.size % BLOCK)) % BLOCK;
        current = null;
        collected = Buffer.alloc(0);
      }
    }
  }
  return written;
}
