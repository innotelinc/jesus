import { useEffect, useState } from 'react';

/**
 * Minimal history router. Real URLs (not hashes) so directory links are
 * shareable and the server's SPA fallback serves the shell for any path.
 */

const listeners = new Set();

export function navigate(to, { replace = false } = {}) {
  const current = window.location.pathname + window.location.search;
  if (to === current) return;
  if (replace) window.history.replaceState({}, '', to);
  else window.history.pushState({}, '', to);
  listeners.forEach((fn) => fn());
  window.scrollTo({ top: 0 });
}

export function useLocation() {
  const [, force] = useState(0);
  useEffect(() => {
    const update = () => force((n) => n + 1);
    listeners.add(update);
    window.addEventListener('popstate', update);
    return () => {
      listeners.delete(update);
      window.removeEventListener('popstate', update);
    };
  }, []);
  return { pathname: window.location.pathname, search: window.location.search };
}

export function Link({ to, children, onClick, ...rest }) {
  return (
    <a
      href={to}
      onClick={(event) => {
        onClick?.(event);
        if (event.defaultPrevented) return;
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
        event.preventDefault();
        navigate(to);
      }}
      {...rest}
    >
      {children}
    </a>
  );
}
