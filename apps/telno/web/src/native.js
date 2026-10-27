/**
 * The page's half of the native SCIF app.
 *
 * The wrapper loads this same softphone, so everything native has to be
 * discovered at runtime rather than built in: in a browser `Capacitor` is
 * undefined and every function here is a no-op, which is what keeps one build
 * serving both.
 *
 * Two bridges:
 *
 *   ScifCall    PushKit + CallKit. The page registers the phone's VoIP token
 *               against the line and reacts when a call is answered or declined.
 *   ScifSpeech  SFSpeechRecognizer. WKWebView has no Web Speech API, so the
 *               wrapped app needs Apple's recognizer for dialing by voice; this
 *               installs it as window.ScifNative, which speech.js prefers.
 */

import { api } from './api.js';

const plugins = () => (typeof window !== 'undefined' && window.Capacitor?.Plugins) || {};

export const nativeCall = () => plugins().ScifCall || null;

export const isNativeApp = () => !!nativeCall();

/**
 * Expose dictation to speech.js. Idempotent: React remounts, the bridge does not
 * need rebuilding.
 */
export function installSpeechBridge() {
  const speech = plugins().ScifSpeech;
  if (!speech || typeof window === 'undefined' || window.ScifNative?.__installed) return;
  window.ScifNative = {
    __installed: true,
    recognize({ lang, onText, onFinal, onError }) {
      const handles = [];
      const stop = () => {
        handles.forEach((handle) => {
          try {
            handle?.remove?.();
          } catch {
            /* listener already gone */
          }
        });
        handles.length = 0;
      };
      handles.push(speech.addListener('partial', (data) => onText?.(data?.text || '')));
      handles.push(
        speech.addListener('final', (data) => {
          onFinal?.(data?.text || '');
          stop();
        })
      );
      handles.push(
        speech.addListener('error', (data) => {
          onError?.(data?.message || 'Speech recognition failed');
          stop();
        })
      );
      speech.recognize({ lang: lang || navigator.language || 'en-US' }).catch((err) => {
        onError?.(err?.message || 'Speech recognition could not start');
        stop();
      });
      return () => {
        try {
          speech.stop();
        } catch {
          /* already stopped */
        }
        stop();
      };
    },
  };
}

if (typeof window !== 'undefined') installSpeechBridge();

/**
 * Register this phone for calls, and keep the token current.
 *
 * A VoIP token is issued asynchronously and can rotate, so this listens rather
 * than reading once: the platform must learn the new token or the line stops
 * ringing and nobody knows why.
 */
export function watchCalls({ extension, onIncoming, onAnswered, onEnded, onError } = {}) {
  const call = nativeCall();
  if (!call || !extension) return () => {};

  const handles = [];
  let environment = 'development';
  let bundleId = '';

  const post = async (token) => {
    if (!token || token.length < 32) return;
    try {
      await api.post('/softphone/push/register', {
        extension,
        token,
        platform: 'ios',
        bundleId,
        environment,
        deviceName: 'iPhone',
      });
    } catch (err) {
      onError?.(err?.message || 'This phone could not be registered for calls');
    }
  };

  call
    .register()
    .then((result) => {
      bundleId = result?.bundleId || '';
      // A debug build is signed against the sandbox; TestFlight and the store are
      // signed for production, and a token from one will never work against the
      // other.
      environment = result?.debug ? 'development' : 'production';
      if (result?.token) post(result.token);
    })
    .catch((err) => onError?.(err?.message || 'Push registration failed'));

  handles.push(call.addListener('token', (data) => post(data?.token)));
  handles.push(call.addListener('incomingCall', (callInfo) => onIncoming?.(callInfo)));
  handles.push(call.addListener('answered', (data) => onAnswered?.(data?.id || '')));
  handles.push(call.addListener('ended', (data) => onEnded?.(data?.id || '', data?.reason || '')));

  return () => {
    handles.forEach((handle) => {
      try {
        handle?.remove?.();
      } catch {
        /* already removed */
      }
    });
  };
}
