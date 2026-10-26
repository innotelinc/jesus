import { extname } from 'node:path';
import { db_, now } from '../db/index.js';
import { config } from '../config.js';
import { logEvent } from '../lib/audit.js';
import { notFound, badRequest } from '../lib/errors.js';
import {
  EXT_FOR_TYPE,
  MEDIA_TYPES,
  acceptedExtension,
  describeMedia,
  mediaName,
  readStream,
  removeMedia,
  saveMedia,
} from '../lib/media.js';

/**
 * Audio and attachments. Everything here sits behind the same session/API-key
 * gate as the rest of the workspace; the browser's <audio> element sends the
 * session cookie, so playback needs no signed URL.
 */
export default async function mediaRoutes(app) {
  app.addHook('preHandler', async (request) => {
    const scope = ['GET', 'HEAD', 'OPTIONS'].includes(request.method) ? 'registry:read' : 'registry:write';
    await app.authenticateAny(request, scope);
  });
  const requireWrite = app.requireRole('owner', 'operator');

  /** Streams a stored file, honoring a single Range so seeking works. */
  function sendMedia(request, reply, name) {
    const info = describeMedia(name);
    if (!info) throw notFound('No media stored for this record');
    const file = name;
    const type = MEDIA_TYPES[extname(file).toLowerCase()] || 'application/octet-stream';
    reply.header('accept-ranges', 'bytes');
    reply.header('cache-control', 'private, no-store');

    const range = request.headers.range;
    if (range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(String(range));
      if (!match) throw badRequest('Unsupported range');
      const start = match[1] ? Number(match[1]) : 0;
      const end = match[2] ? Math.min(Number(match[2]), info.size - 1) : info.size - 1;
      if (Number.isNaN(start) || start > end) throw badRequest('Range out of bounds');
      reply.status(206);
      reply.header('content-range', `bytes ${start}-${end}/${info.size}`);
      reply.header('content-length', end - start + 1);
      return reply.type(type).send(readStream(file, { start, end }));
    }
    reply.header('content-length', info.size);
    return reply.type(type).send(readStream(file));
  }

  /** Raw body upload: the content type decides the extension, never the name. */
  function takeUpload(request) {
    const body = request.body;
    if (!Buffer.isBuffer(body) || !body.length) throw badRequest('Send the file as the request body');
    if (body.length > config.mediaMaxBytes) throw badRequest('That file is too large');
    const extension = EXT_FOR_TYPE[String(request.headers['content-type'] || '').split(';')[0].trim()];
    if (!extension) throw badRequest('Unsupported file type');
    return { buffer: body, extension };
  }

  /* ------------------------------------------------------------ voicemail -- */
  app.get('/voicemails/:id/audio', async (request, reply) => {
    const row = db_.get('SELECT * FROM voicemails WHERE id = ?', [request.params.id]);
    if (!row) throw notFound('Voicemail not found');
    return sendMedia(request, reply, row.recording);
  });

  app.put('/voicemails/:id/audio', { preHandler: requireWrite }, async (request) => {
    const row = db_.get('SELECT * FROM voicemails WHERE id = ?', [request.params.id]);
    if (!row) throw notFound('Voicemail not found');
    const { buffer, extension } = takeUpload(request);
    const name = mediaName('vm', extension);
    saveMedia(name, buffer);
    removeMedia(row.recording);
    db_.run('UPDATE voicemails SET recording = ? WHERE id = ?', [name, row.id]);
    logEvent({
      actor: request.account.email,
      action: 'voicemail.audio_uploaded',
      subject: row.extension || row.id,
      detail: `${Math.round(buffer.length / 1024)} KB ${extension}`,
      ip: request.ip,
    });
    return { voicemail: { id: row.id, recording: true, audioUrl: `/api/voicemails/${row.id}/audio` } };
  });

  /* ----------------------------------------------------------------- calls -- */
  app.get('/calls/:id/audio', async (request, reply) => {
    const row = db_.get('SELECT * FROM calls WHERE id = ?', [request.params.id]);
    if (!row) throw notFound('Call not found');
    return sendMedia(request, reply, row.recording);
  });

  app.put('/calls/:id/audio', { preHandler: requireWrite }, async (request) => {
    const row = db_.get('SELECT * FROM calls WHERE id = ?', [request.params.id]);
    if (!row) throw notFound('Call not found');
    const { buffer, extension } = takeUpload(request);
    const name = mediaName('call', extension);
    saveMedia(name, buffer);
    removeMedia(row.recording);
    db_.run('UPDATE calls SET recording = ? WHERE id = ?', [name, row.id]);
    logEvent({
      actor: request.account.email,
      action: 'call.recording_uploaded',
      subject: row.call_id,
      detail: `${Math.round(buffer.length / 1024)} KB ${extension}`,
      ip: request.ip,
    });
    return { call: { id: row.id, recording: true, audioUrl: `/api/calls/${row.id}/audio` } };
  });

  /* ------------------------------------------------------------------ fax -- */
  app.get('/faxes/:id/attachment', async (request, reply) => {
    const row = db_.get('SELECT * FROM faxes WHERE id = ?', [request.params.id]);
    if (!row) throw notFound('Fax not found');
    if (row.attachment_name) reply.header('content-disposition', `inline; filename="${row.attachment_name.replace(/"/g, '')}"`);
    return sendMedia(request, reply, row.attachment);
  });

  app.put('/faxes/:id/attachment', { preHandler: requireWrite }, async (request) => {
    const row = db_.get('SELECT * FROM faxes WHERE id = ?', [request.params.id]);
    if (!row) throw notFound('Fax not found');
    const { buffer, extension } = takeUpload(request);
    const provided = String(request.headers['x-file-name'] || '').slice(0, 120);
    const display = provided && acceptedExtension(provided) ? provided : `fax.${extension}`;
    const name = mediaName('fax', extension);
    saveMedia(name, buffer);
    removeMedia(row.attachment);
    db_.run('UPDATE faxes SET attachment = ?, attachment_name = ?, document = ? WHERE id = ?', [
      name,
      display,
      display,
      row.id,
    ]);
    logEvent({
      actor: request.account.email,
      action: 'fax.attachment_uploaded',
      subject: row.id,
      detail: `${display} ${Math.round(buffer.length / 1024)} KB`,
      ip: request.ip,
    });
    return { fax: { id: row.id, attachmentName: display, attachmentUrl: `/api/faxes/${row.id}/attachment` } };
  });

  app.delete('/faxes/:id/attachment', { preHandler: requireWrite }, async (request) => {
    const row = db_.get('SELECT * FROM faxes WHERE id = ?', [request.params.id]);
    if (!row) throw notFound('Fax not found');
    removeMedia(row.attachment);
    db_.run("UPDATE faxes SET attachment = '', attachment_name = '', document = '' WHERE id = ?", [row.id]);
    logEvent({ actor: request.account.email, action: 'fax.attachment_removed', subject: row.id, ip: request.ip });
    return { ok: true, at: now() };
  });
}
