import { describe, it, expect, afterEach } from 'vitest';
import {
  sanitizeThemeCSS,
  validateThemeSelectors,
  injectThemeCSS,
  removeThemeCSS,
  validateThemeCSSSafety,
} from '../theme-loader';

describe('theme-loader', () => {
  describe('sanitizeThemeCSS', () => {
    it('passes through safe CSS unchanged', () => {
      const css = ':root { --color-primary: #3b82f6; }';
      const { css: cleaned, warnings } = sanitizeThemeCSS(css);
      expect(cleaned).toBe(css);
      expect(warnings).toHaveLength(0);
    });

    it('strips @import directives', () => {
      const css = '@import url("evil.css");\n:root { --color-primary: red; }';
      const { css: cleaned, warnings } = sanitizeThemeCSS(css);
      expect(cleaned).not.toContain('@import');
      expect(warnings.length).toBeGreaterThan(0);
    });

    it('strips external url() references', () => {
      const css = ':root { background: url("https://evil.com/track.png"); }';
      const { css: cleaned, warnings } = sanitizeThemeCSS(css);
      expect(cleaned).not.toContain('https://evil.com');
      expect(warnings.length).toBeGreaterThan(0);
    });

    it('strips javascript: in CSS', () => {
      const css = ':root { background: javascript:alert(1); }';
      const { css: cleaned, warnings } = sanitizeThemeCSS(css);
      expect(cleaned).not.toContain('javascript:');
      expect(warnings.length).toBeGreaterThan(0);
    });

    it('strips expression()', () => {
      const css = ':root { width: expression(document.body.clientWidth); }';
      const { css: cleaned, warnings } = sanitizeThemeCSS(css);
      expect(cleaned).not.toContain('expression(');
      expect(warnings.length).toBeGreaterThan(0);
    });

    it('strips -moz-binding', () => {
      const css = ':root { -moz-binding: url("evil.xml#xbl"); }';
      const { css: cleaned, warnings } = sanitizeThemeCSS(css);
      expect(cleaned).not.toContain('-moz-binding');
      expect(warnings.length).toBeGreaterThan(0);
    });

    it('strips behavior:', () => {
      const css = ':root { behavior: url(evil.htc); }';
      const { css: cleaned, warnings } = sanitizeThemeCSS(css);
      expect(cleaned).not.toContain('behavior');
      expect(warnings.length).toBeGreaterThan(0);
    });

    it('strips multiple dangerous patterns at once', () => {
      const css = '@import url("a.css"); :root { -moz-binding: url("b.xml"); background: expression(1); }';
      const { css: cleaned, warnings } = sanitizeThemeCSS(css);
      expect(cleaned).not.toContain('@import');
      expect(cleaned).not.toContain('-moz-binding');
      expect(cleaned).not.toContain('expression(');
      expect(warnings.length).toBeGreaterThanOrEqual(3);
    });
  });

  describe('validateThemeSelectors', () => {
    it('accepts :root selector', () => {
      const warnings = validateThemeSelectors(':root { --color-primary: red; }');
      expect(warnings).toHaveLength(0);
    });

    it('accepts .dark selector', () => {
      const warnings = validateThemeSelectors('.dark { --color-primary: blue; }');
      expect(warnings).toHaveLength(0);
    });

    it('accepts @media queries', () => {
      const css = '@media (prefers-color-scheme: dark) { :root { --color-bg: #000; } }';
      const warnings = validateThemeSelectors(css);
      expect(warnings).toHaveLength(0);
    });

    it('accepts @font-face', () => {
      const css = '@font-face { font-family: "Test"; src: local("Test"); }';
      const warnings = validateThemeSelectors(css);
      expect(warnings).toHaveLength(0);
    });

    it('warns about body selector', () => {
      const css = 'body { background: red; }';
      const warnings = validateThemeSelectors(css);
      expect(warnings.length).toBeGreaterThan(0);
      expect(warnings[0]).toContain('body');
    });

    it('warns about element selectors', () => {
      const css = 'button { color: red; }';
      const warnings = validateThemeSelectors(css);
      expect(warnings.length).toBeGreaterThan(0);
    });

    it('warns about class selectors other than .dark', () => {
      const css = '.my-class { color: red; }';
      const warnings = validateThemeSelectors(css);
      expect(warnings.length).toBeGreaterThan(0);
    });
  });

  describe('injectThemeCSS / removeThemeCSS', () => {
    afterEach(() => {
      removeThemeCSS();
    });

    it('injects a style element into head', () => {
      injectThemeCSS(':root { --color-primary: red; }');
      const styleEl = document.getElementById('active-theme');
      expect(styleEl).not.toBeNull();
      expect(styleEl?.tagName).toBe('STYLE');
      expect(styleEl?.textContent).toBe(':root { --color-primary: red; }');
    });

    it('updates existing style element on subsequent call', () => {
      injectThemeCSS(':root { --color-primary: red; }');
      injectThemeCSS(':root { --color-primary: blue; }');
      const styleEls = document.querySelectorAll('#active-theme');
      expect(styleEls).toHaveLength(1);
      expect(styleEls[0].textContent).toBe(':root { --color-primary: blue; }');
    });

    it('removeThemeCSS removes the style element', () => {
      injectThemeCSS(':root { --color-primary: red; }');
      removeThemeCSS();
      const styleEl = document.getElementById('active-theme');
      expect(styleEl).toBeNull();
    });

    it('removeThemeCSS is safe when no theme is injected', () => {
      expect(() => removeThemeCSS()).not.toThrow();
    });
  });

  describe('validateThemeCSSSafety', () => {
    it('accepts valid theme CSS', () => {
      const css = ':root { --color-primary: #3b82f6; --color-background: #fff; }';
      const { valid, errors } = validateThemeCSSSafety(css);
      expect(valid).toBe(true);
      expect(errors).toHaveLength(0);
    });

    it('rejects empty CSS', () => {
      const { valid, errors } = validateThemeCSSSafety('   ');
      expect(valid).toBe(false);
      expect(errors).toContain('Theme CSS is empty');
    });

    it('rejects CSS without color variables', () => {
      const css = ':root { font-size: 16px; }';
      const { valid, errors } = validateThemeCSSSafety(css);
      expect(valid).toBe(false);
      expect(errors.some(e => e.includes('--color-'))).toBe(true);
    });

    it('flags dangerous patterns', () => {
      const css = ':root { --color-primary: red; } @import url("evil.css");';
      const { valid, errors } = validateThemeCSSSafety(css);
      expect(valid).toBe(false);
      expect(errors.some(e => e.includes('disallowed'))).toBe(true);
    });
  });
});
