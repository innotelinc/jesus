import { createReadStream, existsSync, mkdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { config } from '../config.js';

/**
 * Media files (call audio, voicemail audio, fax attachments) live on the data
 * volume rather than in SQLite: the database stores only the file name, so
 * backups of /data carry both.
 */

export const MEDIA_TYPES = {
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.webm': 'audio/webm',
  '.m4a': 'audio/mp4',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
};

export const EXT_FOR_TYPE = {
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/wave': 'wav',
  'audio/mpeg': 'mp3',
  'audio/ogg': 'ogg',
  'audio/webm': 'webm',
  'audio/mp4': 'm4a',
  'application/pdf': 'pdf',
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/tiff': 'tif',
};

const ACCEPTED = new Set(['.wav', '.mp3', '.ogg', '.webm', '.m4a', '.pdf', '.png', '.jpg', '.jpeg', '.tif', '.tiff']);

export function ensureMediaDir() {
  mkdirSync(config.recordingsDir, { recursive: true });
  return config.recordingsDir;
}

export const mediaPath = (name) => join(config.recordingsDir, name);

/** File names are generated here, never taken from a request path. */
export function mediaName(prefix, extension) {
  return `${prefix}_${randomBytes(9).toString('hex')}.${extension}`;
}

export function saveMedia(name, buffer) {
  ensureMediaDir();
  writeFileSync(mediaPath(name), buffer);
  return name;
}

export function describeMedia(name) {
  if (!name) return null;
  const file = mediaPath(name);
  if (!existsSync(file)) return null;
  const stats = statSync(file);
  return {
    name,
    size: stats.size,
    type: MEDIA_TYPES[extname(file).toLowerCase()] || 'application/octet-stream',
  };
}

export function removeMedia(name) {
  if (!name) return;
  try {
    unlinkSync(mediaPath(name));
  } catch {
    /* a missing file is not an error */
  }
}

export function readStream(name, options = {}) {
  return createReadStream(mediaPath(name), options);
}

export const acceptedExtension = (name) => ACCEPTED.has(extname(String(name || '')).toLowerCase());
