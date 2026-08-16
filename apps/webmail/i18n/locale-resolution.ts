import { routing } from './routing';

/** Map a BCP 47 language tag to the locale code Bulwark supports. */
export function normalizeLocaleTag(tag: string): string {
  const base = tag.trim().toLowerCase().split('-')[0];
  return base === 'no' ? 'nb' : base;
}

/** Pick the highest-ranked supported locale from an Accept-Language header. */
export function localeFromAcceptLanguage(header: string | null): string | null {
  if (!header) return null;
  const supported = new Set<string>(routing.locales as readonly string[]);
  const ranked = header
    .split(',')
    .map((part) => {
      const [tag, q] = part.trim().split(';q=');
      return { locale: normalizeLocaleTag(tag), q: q ? parseFloat(q) : 1 };
    })
    .sort((a, b) => b.q - a.q);

  for (const { locale } of ranked) {
    if (supported.has(locale)) return locale;
  }
  return null;
}
