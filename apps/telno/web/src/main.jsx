import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import './styles.css';

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>
);

/**
 * The service worker exists so the softphone can be installed as its own window.
 * It caches nothing (see public/sw.js), so registering it cannot serve a stale
 * console — the only thing that changes is that the browser offers an install.
 *
 * Registered after the app is on screen, and never in development: a worker
 * around a Vite dev server is a debugging trap with no upside.
 */
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {
      /* installability is a convenience; the phone works without it */
    });
  });
}
