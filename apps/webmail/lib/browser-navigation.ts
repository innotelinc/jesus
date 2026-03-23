import { locales } from '@/i18n/routing';

export function replaceWindowLocation(url: string): void {
  if (typeof window === 'undefined') {
    return;
  }

  window.location.replace(url);
}

/**
 * Returns the mount prefix from the current URL.
 * When the app is served behind a reverse proxy at e.g. /bulwark,
 * the browser sees /bulwark/en/login while Next.js sees /en/login.
 *
 * If a locale is supplied (e.g. from route params) it is used directly;
 * otherwise the first path segment that matches a known locale is used.
 *
 * Returns '' when there is no prefix.
 */
export function getPathPrefix(locale?: string): string {
  if (typeof window === 'undefined') return '';

  const segments = window.location.pathname.split('/').filter(Boolean);

  let localeIndex: number;
  if (locale) {
    localeIndex = segments.indexOf(locale);
  } else {
    localeIndex = segments.findIndex(s =>
      (locales as readonly string[]).includes(s)
    );
  }

  if (localeIndex <= 0) return '';
  return '/' + segments.slice(0, localeIndex).join('/');
}

/**
 * Extracts the locale from the current URL, skipping any mount prefix.
 * Falls back to 'en' when no known locale segment is found.
 */
export function getLocaleFromPath(): string {
  if (typeof window === 'undefined') return 'en';

  const segments = window.location.pathname.split('/').filter(Boolean);
  const locale = segments.find(s =>
    (locales as readonly string[]).includes(s)
  );
  return locale || 'en';
}