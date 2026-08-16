import { afterEach, describe, expect, it } from 'vitest';
import { detectBrowserLocale } from '../detect-locale';
import { localeFromAcceptLanguage, normalizeLocaleTag } from '../locale-resolution';

const originalLanguages = Object.getOwnPropertyDescriptor(navigator, 'languages');

function setBrowserLanguages(languages: string[]) {
  Object.defineProperty(navigator, 'languages', {
    configurable: true,
    value: languages,
  });
}

afterEach(() => {
  if (originalLanguages) {
    Object.defineProperty(navigator, 'languages', originalLanguages);
  } else {
    Reflect.deleteProperty(navigator, 'languages');
  }
});

describe('Norwegian locale aliases', () => {
  it.each(['no', 'no-NO'])('normalizes %s to Bokmål', (tag) => {
    expect(normalizeLocaleTag(tag)).toBe('nb');
  });

  it('keeps native Bokmål tags on nb', () => {
    expect(normalizeLocaleTag('nb-NO')).toBe('nb');
  });

  it('resolves no-NO from Accept-Language using quality ranking', () => {
    expect(localeFromAcceptLanguage('da;q=0.5, no-NO;q=0.9, en;q=0.8')).toBe('nb');
  });

  it.each(['no', 'no-NO'])('detects browser language %s as Bokmål', (tag) => {
    setBrowserLanguages([tag]);
    expect(detectBrowserLocale('en')).toBe('nb');
  });
});
