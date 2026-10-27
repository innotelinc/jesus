/**
 * SCIF — the secure profile of a line.
 *
 * "Secure" has to mean something a switch and a browser can both enforce, so it
 * is defined here as four concrete promises:
 *
 *   1. Media is DTLS-SRTP. The generated WebRTC endpoint already refuses
 *      anything else; SCIF makes the browser hang up rather than fall back.
 *   2. Recording is off. A SCIF line is never mixed to disk, whatever a voice
 *      agent's policy says, because the dialplan is where recording is decided.
 *   3. Caller ID is withheld, or presented as a chosen number — decided on the
 *      switch, so it applies to every device on the line, not just this browser.
 *   4. Text and voicemail identity can be masked in the app: phone numbers and
 *      addresses are redacted before the list leaves the API.
 *
 * What it is not: end-to-end encryption. Encryption is per hop (browser →
 * switch → trunk), and a call that reaches the PSTN is unencrypted on the last
 * leg. No amount of client software changes that. docs/SCIF.md says so plainly.
 */

export const CALLER_ID_MODES = ['own', 'anonymous', 'custom'];
export const VOICE_MASKS = ['off', 'low', 'high', 'robot'];

/** The policy a session, a screen and the switch all read from one row. */
export function scifPolicy(extension) {
  const enabled = !!extension?.scif;
  const mode = CALLER_ID_MODES.includes(extension?.caller_id_mode) ? extension.caller_id_mode : 'own';
  const effective = enabled ? mode : 'own';
  return {
    enabled,
    callerId: {
      mode: effective,
      number: extension?.caller_id_number || '',
      // What the switch actually does: withhold the presentation, or send it.
      presentation: effective === 'anonymous' ? 'prohibited' : 'allowed',
    },
    voiceMask: VOICE_MASKS.includes(extension?.voice_mask) ? extension.voice_mask : 'off',
    maskText: enabled && !!extension?.mask_text,
    // Recording cannot be turned on from here: it is off, and the dialplan for
    // this line carries no MixMonitor at all.
    recording: 'off',
    encryption: 'dtls-srtp',
    requiresEncryption: enabled,
  };
}

/** The caller ID string pjsip.conf should carry for this endpoint. */
export function callerIdString(extension) {
  const name = String(extension?.display_name || extension?.extension || '').replace(/["<>]/g, '');
  const fallback = extension?.extension;
  if (!extension?.scif) return `"${name}" <${fallback}>`;
  if (extension.caller_id_mode === 'anonymous') return '"Anonymous" <anonymous>';
  if (extension.caller_id_mode === 'custom' && extension.caller_id_number) {
    return `"${name}" <${String(extension.caller_id_number).replace(/[^\d+]/g, '')}>`;
  }
  return `"${name}" <${fallback}>`;
}

/* ---------------------------------------------------------------- masking -- */

/** Keep the shape and the last two digits: +1 ••• ••• ••77. */
export function maskPhone(value) {
  const text = String(value || '');
  const digits = text.replace(/\D/g, '');
  if (digits.length < 4) return text;
  const prefix = text.trim().startsWith('+') ? `+${digits.slice(0, 1)}` : '';
  return `${prefix} ${'•'.repeat(Math.min(9, digits.length - 2)).replace(/(.{3})(?=.)/g, '$1 ')}${digits.slice(-2)}`.trim();
}

/** a•••@example.com — the domain stays, because it is the useful part. */
export function maskEmail(value) {
  const text = String(value || '');
  const at = text.indexOf('@');
  if (at < 1) return text;
  return `${text.slice(0, 1)}${'•'.repeat(Math.min(4, Math.max(2, at - 1)))}${text.slice(at)}`;
}

const PHONE_LIKE = /\+?\d[\d\s().-]{5,}\d/g;
const EMAIL_LIKE = /[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi;
// A date is not a phone number, however much an 11-digit run looks like one.
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const DATE_OR_TIME = /^\d{1,2}:\d{2}$/;

/**
 * Redact identifiers in free text — a transcript, an SMS body, a subject line.
 *
 * Deliberately conservative: it masks things that look like a phone number or an
 * email, and leaves words alone. A masker that guesses at names would garble
 * messages and make the feature untrustworthy.
 */
export function maskText(value) {
  const text = String(value ?? '');
  if (!text) return text;
  return text
    .replace(EMAIL_LIKE, (match) => maskEmail(match))
    .replace(PHONE_LIKE, (match) => {
      if (ISO_DATE.test(match.trim()) || DATE_OR_TIME.test(match.trim())) return match;
      return match.replace(/\D/g, '').length >= 7 ? maskPhone(match) : match;
    });
}

/** Does this line ask for masked identity? */
export const masksFor = (extension) => !!(extension?.scif && extension?.mask_text);

/** The set of numbers whose lines asked for masking, resolved once per request. */
export function maskedNumberIds(db_) {
  return new Set(
    db_
      .all('SELECT DISTINCT number_id FROM extensions WHERE scif = 1 AND mask_text = 1 AND number_id IS NOT NULL')
      .map((row) => row.number_id)
  );
}

/** Extensions that ask for masking, by extension number. */
export function maskedExtensions(db_) {
  return new Map(
    db_
      .all('SELECT extension, scif, mask_text FROM extensions WHERE scif = 1 AND mask_text = 1')
      .map((row) => [String(row.extension), row])
  );
}
