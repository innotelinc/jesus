const PARENT_ORIGIN = typeof window !== 'undefined'
  ? (document.querySelector('meta[name="parent-origin"]')?.getAttribute('content') || '')
  : '';

export function isEmbedded(): boolean {
  try {
    return window.self !== window.top;
  } catch {
    return true;
  }
}

export function notifyParent(type: string, payload: Record<string, unknown> = {}) {
  if (!isEmbedded()) return;

  const targetOrigin = PARENT_ORIGIN || '*';
  try {
    window.parent.postMessage({ source: 'bulwark', type, ...payload }, targetOrigin);
  } catch {
    // Cross-origin postMessage may fail in restricted contexts
  }
}

export function listenFromParent(
  handler: (msg: { type: string; [k: string]: unknown }) => void,
  allowedOrigin?: string,
): () => void {
  const listener = (event: MessageEvent) => {
    // Validate origin if configured
    if (allowedOrigin && event.origin !== allowedOrigin) return;

    // Only accept messages from the portal
    if (!event.data || event.data.source !== 'portal') return;

    handler(event.data);
  };

  window.addEventListener('message', listener);
  return () => window.removeEventListener('message', listener);
}
