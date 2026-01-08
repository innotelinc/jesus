import { describe, it, expect } from 'vitest';
import {
  parseColor,
  getLuminance,
  isDarkColor,
  transformColorForDarkMode,
  transformInlineStyles,
} from '../color-transform';

describe('parseColor', () => {
  describe('hex colors', () => {
    it('should parse 6-digit hex colors', () => {
      expect(parseColor('#333333')).toEqual({ r: 51, g: 51, b: 51 });
      expect(parseColor('#AABBCC')).toEqual({ r: 170, g: 187, b: 204 });
      expect(parseColor('#ffffff')).toEqual({ r: 255, g: 255, b: 255 });
    });

    it('should parse 3-digit hex colors', () => {
      expect(parseColor('#FFF')).toEqual({ r: 255, g: 255, b: 255 });
      expect(parseColor('#ABC')).toEqual({ r: 170, g: 187, b: 204 });
      expect(parseColor('#000')).toEqual({ r: 0, g: 0, b: 0 });
    });

    it('should handle uppercase and lowercase', () => {
      expect(parseColor('#aabbcc')).toEqual(parseColor('#AABBCC'));
      expect(parseColor('#fff')).toEqual(parseColor('#FFF'));
    });
  });

  describe('rgb/rgba colors', () => {
    it('should parse rgb colors', () => {
      expect(parseColor('rgb(51, 51, 51)')).toEqual({ r: 51, g: 51, b: 51 });
      expect(parseColor('rgb(255, 0, 0)')).toEqual({ r: 255, g: 0, b: 0 });
    });

    it('should parse rgba colors', () => {
      expect(parseColor('rgba(51, 51, 51, 0.5)')).toEqual({ r: 51, g: 51, b: 51, a: 0.5 });
      expect(parseColor('rgba(0, 0, 0, 0.8)')).toEqual({ r: 0, g: 0, b: 0, a: 0.8 });
    });

    it('should handle spaces in rgb/rgba', () => {
      expect(parseColor('rgb(51,51,51)')).toEqual({ r: 51, g: 51, b: 51 });
      expect(parseColor('rgba(51,  51,  51,  0.5)')).toEqual({ r: 51, g: 51, b: 51, a: 0.5 });
    });
  });

  describe('hsl/hsla colors', () => {
    it('should parse hsl colors', () => {
      const result = parseColor('hsl(0, 0%, 20%)');
      expect(result).toEqual({ r: 51, g: 51, b: 51 });
    });

    it('should parse hsla colors', () => {
      const result = parseColor('hsla(0, 0%, 20%, 0.5)');
      expect(result).toEqual({ r: 51, g: 51, b: 51, a: 0.5 });
    });

    it('should convert hsl to rgb correctly', () => {
      const red = parseColor('hsl(0, 100%, 50%)');
      expect(red).toEqual({ r: 255, g: 0, b: 0 });

      const green = parseColor('hsl(120, 100%, 50%)');
      expect(green).toEqual({ r: 0, g: 255, b: 0 });

      const blue = parseColor('hsl(240, 100%, 50%)');
      expect(blue).toEqual({ r: 0, g: 0, b: 255 });
    });
  });

  describe('named colors', () => {
    it('should parse named colors', () => {
      expect(parseColor('black')).toEqual({ r: 0, g: 0, b: 0 });
      expect(parseColor('white')).toEqual({ r: 255, g: 255, b: 255 });
      expect(parseColor('red')).toEqual({ r: 255, g: 0, b: 0 });
      expect(parseColor('green')).toEqual({ r: 0, g: 128, b: 0 });
      expect(parseColor('blue')).toEqual({ r: 0, g: 0, b: 255 });
    });

    it('should handle transparent', () => {
      expect(parseColor('transparent')).toEqual({ r: 0, g: 0, b: 0, a: 0 });
    });
  });

  describe('edge cases', () => {
    it('should return null for invalid colors', () => {
      expect(parseColor('invalid')).toBeNull();
      expect(parseColor('#GGGGGG')).toBeNull();
      expect(parseColor('rgb(300, 400, 500)')).toBeNull();
    });

    it('should return null for inherit and currentColor', () => {
      expect(parseColor('inherit')).toBeNull();
      expect(parseColor('currentColor')).toBeNull();
      expect(parseColor('currentcolor')).toBeNull();
    });

    it('should handle empty or invalid input', () => {
      expect(parseColor('')).toBeNull();
      expect(parseColor('   ')).toBeNull();
    });
  });
});

describe('getLuminance', () => {
  it('should calculate luminance for black', () => {
    expect(getLuminance(0, 0, 0)).toBe(0);
  });

  it('should calculate luminance for white', () => {
    expect(getLuminance(255, 255, 255)).toBe(1);
  });

  it('should calculate luminance for gray', () => {
    const luminance = getLuminance(128, 128, 128);
    expect(luminance).toBeGreaterThan(0);
    expect(luminance).toBeLessThan(1);
    expect(luminance).toBeCloseTo(0.215, 2);
  });

  it('should calculate luminance for dark colors', () => {
    const darkGray = getLuminance(51, 51, 51);
    expect(darkGray).toBeLessThan(0.5);
  });

  it('should calculate luminance for light colors', () => {
    const lightGray = getLuminance(200, 200, 200);
    expect(lightGray).toBeGreaterThan(0.5);
  });
});

describe('isDarkColor', () => {
  it('should identify dark colors', () => {
    expect(isDarkColor('#000000')).toBe(true);
    expect(isDarkColor('#111111')).toBe(true);
    expect(isDarkColor('#333333')).toBe(true);
    expect(isDarkColor('rgb(51, 51, 51)')).toBe(true);
  });

  it('should identify light colors', () => {
    expect(isDarkColor('#ffffff')).toBe(false);
    expect(isDarkColor('#eeeeee')).toBe(false);
    expect(isDarkColor('rgb(200, 200, 200)')).toBe(false);
  });

  it('should return false for invalid colors', () => {
    expect(isDarkColor('invalid')).toBe(false);
    expect(isDarkColor('inherit')).toBe(false);
  });
});

describe('transformColorForDarkMode', () => {
  it('should lighten very dark colors', () => {
    const original = '#111111';
    const transformed = transformColorForDarkMode(original);
    const originalRgb = parseColor(original)!;
    const transformedRgb = parseColor(transformed)!;

    expect(transformedRgb.r).toBeGreaterThan(originalRgb.r);
    expect(transformedRgb.g).toBeGreaterThan(originalRgb.g);
    expect(transformedRgb.b).toBeGreaterThan(originalRgb.b);
  });

  it('should transform #333333 to a lighter color', () => {
    const transformed = transformColorForDarkMode('#333333');
    const rgb = parseColor(transformed)!;
    const luminance = getLuminance(rgb.r, rgb.g, rgb.b);
    expect(luminance).toBeGreaterThan(0.4);
  });

  it('should preserve already light colors', () => {
    const lightColors = ['#eeeeee', '#ffffff', 'rgb(200, 200, 200)'];
    lightColors.forEach((color) => {
      const original = parseColor(color)!;
      const transformed = parseColor(transformColorForDarkMode(color))!;
      const originalLum = getLuminance(original.r, original.g, original.b);
      const transformedLum = getLuminance(transformed.r, transformed.g, transformed.b);

      expect(transformedLum).toBeGreaterThanOrEqual(originalLum * 0.9);
    });
  });

  it('should handle rgba colors with alpha', () => {
    const original = 'rgba(51, 51, 51, 0.8)';
    const transformed = transformColorForDarkMode(original);
    expect(transformed).toContain('rgba');
    expect(transformed).toContain('0.8');
  });

  it('should preserve nearly transparent colors', () => {
    const original = 'rgba(0, 0, 0, 0.05)';
    const transformed = transformColorForDarkMode(original);
    expect(transformed).toBe(original);
  });

  it('should handle invalid colors gracefully', () => {
    expect(transformColorForDarkMode('invalid')).toBe('invalid');
    expect(transformColorForDarkMode('inherit')).toBe('inherit');
  });

  it('should lighten medium darkness colors', () => {
    const original = '#646463';
    const transformed = transformColorForDarkMode(original);
    const originalRgb = parseColor(original)!;
    const transformedRgb = parseColor(transformed)!;

    expect(transformedRgb.r).toBeGreaterThan(originalRgb.r);
    expect(transformedRgb.g).toBeGreaterThan(originalRgb.g);
    expect(transformedRgb.b).toBeGreaterThan(originalRgb.b);
  });
});

describe('transformInlineStyles', () => {
  it('should not transform styles in light mode', () => {
    const original = 'color: #333333; font-size: 16px';
    expect(transformInlineStyles(original, 'light')).toBe(original);
  });

  it('should transform color property in dark mode', () => {
    const original = 'color: #333333';
    const transformed = transformInlineStyles(original, 'dark');
    expect(transformed).not.toBe(original);
    expect(transformed).toContain('color:');
    expect(transformed).toContain('rgb(');
  });

  it('should transform background-color property', () => {
    const original = 'background-color: #111111';
    const transformed = transformInlineStyles(original, 'dark');
    expect(transformed).not.toBe(original);
    expect(transformed).toContain('background-color:');
  });

  it('should preserve non-color properties', () => {
    const original = 'color: #333333; font-size: 16px; margin: 10px';
    const transformed = transformInlineStyles(original, 'dark');
    expect(transformed).toContain('font-size: 16px');
    expect(transformed).toContain('margin: 10px');
  });

  it('should handle multiple color properties', () => {
    const original = 'color: #111111; background-color: #222222; font-weight: bold';
    const transformed = transformInlineStyles(original, 'dark');
    expect(transformed).toContain('color:');
    expect(transformed).toContain('background-color:');
    expect(transformed).toContain('font-weight: bold');
  });

  it('should preserve !important declarations', () => {
    const original = 'color: #333333 !important';
    const transformed = transformInlineStyles(original, 'dark');
    expect(transformed).toContain('!important');
  });

  it('should handle empty or invalid styles', () => {
    expect(transformInlineStyles('', 'dark')).toBe('');
    expect(transformInlineStyles('invalid', 'dark')).toBe('invalid');
  });

  it('should transform the James Clear email colors', () => {
    const original = 'color: #333333; font-family: Georgia; font-size: 16px';
    const transformed = transformInlineStyles(original, 'dark');

    expect(transformed).toContain('font-family: Georgia');
    expect(transformed).toContain('font-size: 16px');

    const colorMatch = transformed.match(/color:\s*rgb\((\d+),\s*(\d+),\s*(\d+)\)/);
    expect(colorMatch).not.toBeNull();

    if (colorMatch) {
      const [, r, g, b] = colorMatch.map(Number);
      expect(r).toBeGreaterThan(51);
      expect(g).toBeGreaterThan(51);
      expect(b).toBeGreaterThan(51);
    }
  });

  it('should handle background shorthand with color', () => {
    const original = 'background: #333333';
    const transformed = transformInlineStyles(original, 'dark');
    expect(transformed).not.toBe(original);
    expect(transformed).toContain('background:');
  });

  it('should not transform background with url', () => {
    const original = 'background: url(image.jpg) #333333';
    const transformed = transformInlineStyles(original, 'dark');
    expect(transformed).toBe(original);
  });

  it('should transform border-color', () => {
    const original = 'border-color: #111111';
    const transformed = transformInlineStyles(original, 'dark');
    expect(transformed).not.toBe(original);
    expect(transformed).toContain('border-color:');
  });
});
