/**
 * Speech recognition for the softphone.
 *
 * Two engines, one interface, and the choice is made for the user:
 *
 *   browser   Web Speech API (Chrome, Edge, Safari). Free, no key, and on iOS it
 *             is Apple's own recognizer doing the work.
 *   native    `ScifNative.recognize` when the app is wrapped in Capacitor. iOS
 *             in a WKWebView has no Web Speech API, so the wrapper exposes
 *             SFSpeechRecognizer over a small bridge instead. Without this the
 *             feature would silently not exist on the phone.
 *
 * Recognition is not authentication. It turns speech into text — for dialing by
 * voice and for checking that the enrolled phrase was said. The voiceprint is
 * what decides whether the voice belongs to the owner.
 */

const DIGITS = {
  zero: '0',
  oh: '0',
  o: '0',
  one: '1',
  two: '2',
  three: '3',
  four: '4',
  five: '5',
  six: '6',
  seven: '7',
  eight: '8',
  nine: '9',
  star: '*',
  asterisk: '*',
  pound: '#',
  hash: '#',
};

const isDigitWord = (word) => Object.prototype.hasOwnProperty.call(DIGITS, word);

/**
 * "call one oh one" → "101". Also handles "double five" and ignores filler words
 * ("call", "dial", "please"), because speaking a number naturally is the whole
 * point of dialing by voice.
 */
export function digitsFromSpeech(text) {
  const words = String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s*#]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);

  const out = [];
  for (let i = 0; i < words.length; i += 1) {
    const word = words[i];
    if (word === 'double' || word === 'triple') {
      const next = words[i + 1];
      if (isDigitWord(next)) {
        const times = word === 'triple' ? 3 : 2;
        for (let n = 0; n < times; n += 1) out.push(DIGITS[next]);
        i += 1;
      }
      continue;
    }
    if (isDigitWord(word)) {
      out.push(DIGITS[word]);
      continue;
    }
    // A spoken number can also arrive as digits already ("415").
    if (/^[0-9*#]+$/.test(word)) out.push(word);
  }
  return out.join('').slice(0, 24);
}

const nativeBridge = () =>
  typeof window !== 'undefined' && window.ScifNative && typeof window.ScifNative.recognize === 'function'
    ? window.ScifNative
    : null;

export const recognitionSupported = () =>
  !!nativeBridge() ||
  typeof window !== 'undefined' &&
    !!(window.SpeechRecognition || window.webkitSpeechRecognition);

/**
 * Start dictating. Returns a stop function; `onText` fires with the transcript,
 * `onFinal` once when the engine stops, `onError` with a readable reason.
 *
 * A refusal (no microphone permission, no network for the recognizer) is
 * reported rather than hidden: a voice button that does nothing is worse than
 * one that says why.
 */
export function startDictation({ onText, onFinal, onError, lang } = {}) {
  const bridge = nativeBridge();
  if (bridge) {
    const stopNative = bridge.recognize({
      lang: lang || navigator.language || 'en-US',
      onText: (text) => onText?.(text),
      onFinal: (text) => onFinal?.(text),
      onError: (message) => onError?.(mapError(message)),
    });
    return () => {
      try {
        stopNative?.();
      } catch {
        /* the bridge is gone with the page */
      }
    };
  }

  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!Recognition) {
    onError?.('This browser has no speech recognition. Chrome, Edge and Safari do.');
    return () => {};
  }

  const recognition = new Recognition();
  recognition.lang = lang || navigator.language || 'en-US';
  recognition.interimResults = true;
  recognition.continuous = false;
  recognition.maxAlternatives = 1;

  let settled = false;
  recognition.onresult = (event) => {
    let text = '';
    for (let i = event.resultIndex; i < event.results.length; i += 1) {
      text += event.results[i][0].transcript;
    }
    onText?.(text.trim());
    if (event.results[event.results.length - 1]?.isFinal && !settled) {
      settled = true;
      onFinal?.(text.trim());
    }
  };
  recognition.onerror = (event) => {
    if (settled) return;
    settled = true;
    onError?.(mapError(event.error));
  };
  recognition.onend = () => {
    if (settled) return;
    settled = true;
    onFinal?.('');
  };

  try {
    recognition.start();
  } catch (err) {
    onError?.(mapError(err.message));
  }
  return () => {
    try {
      recognition.abort();
    } catch {
      /* already stopped */
    }
  };
}

function mapError(code) {
  const text = String(code || '');
  if (/not-allowed|denied|permission/i.test(text)) return 'Microphone permission was refused';
  if (/no-speech/i.test(text)) return 'Nothing was heard — try again a little closer to the microphone';
  if (/network/i.test(text)) return 'The recognizer needs a network connection';
  if (/audio-capture/i.test(text)) return 'No microphone was found';
  return text || 'Speech recognition failed';
}
