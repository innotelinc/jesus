import { useEffect, useState } from 'react';
import { api } from './api.js';

/**
 * White-label branding, fetched once and applied everywhere.
 *
 * The deployment's name, vendor, accent and logo come from the server, so a
 * reseller edits them in Settings and every surface — marketing site, console
 * header, signup page, document title — changes without a rebuild. The fallback
 * exists so the app renders before the request answers, and so a failed request
 * never leaves the page blank.
 */

const FALLBACK = {
  name: 'Telno',
  vendor: 'Innotel Labs',
  tagline: 'Business phones that answer, dial and grade themselves.',
  description:
    'One number for calls, fax, text and video. Voice agents that pick up and call out. Campaigns whose calls are graded against their own goal, with the report in your inbox.',
  accent: '#6f66ff',
  logoUrl: '',
  supportEmail: '',
  salesEmail: '',
  domain: '',
  footerNote: 'One registry, many doors.',
  subscribeUrl: '/subscribe',
};

let cache = null;
let pending = null;

const hexToRgb = (hex) => {
  const value = String(hex || '').replace('#', '');
  if (!/^[0-9a-fA-F]{6}$/.test(value)) return null;
  return [0, 2, 4].map((offset) => parseInt(value.slice(offset, offset + 2), 16));
};

/** Lighten or darken a hex color by a ratio, for the hover and press tokens. */
const shade = (hex, amount) => {
  const rgb = hexToRgb(hex);
  if (!rgb) return hex;
  const mixed = rgb.map((channel) =>
    Math.max(0, Math.min(255, Math.round(channel + (amount > 0 ? (255 - channel) * amount : channel * amount))))
  );
  return `#${mixed.map((channel) => channel.toString(16).padStart(2, '0')).join('')}`;
};

function applyBrand(brand) {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  const rgb = hexToRgb(brand.accent);
  if (rgb) {
    root.style.setProperty('--accent', brand.accent);
    root.style.setProperty('--accent-hover', shade(brand.accent, 0.16));
    root.style.setProperty('--accent-press', shade(brand.accent, -0.14));
    root.style.setProperty('--accent-soft', `rgba(${rgb.join(', ')}, 0.14)`);
    root.style.setProperty('--accent-ring', `rgba(${rgb.join(', ')}, 0.4)`);
    // The theme is dark; a very dark accent would be invisible on it.
    const luminance = (0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]) / 255;
    root.style.setProperty('--accent-contrast', luminance > 0.62 ? '#0b0b12' : '#ffffff');
  }
  document.title = `${brand.name} — ${brand.tagline}`;
}

export function useBrand() {
  const [brand, setBrand] = useState(cache || FALLBACK);

  useEffect(() => {
    if (cache) {
      applyBrand(cache);
      return;
    }
    if (!pending) {
      pending = api
        .get('/public/brand')
        .then((data) => {
          cache = { ...FALLBACK, ...(data.brand || {}) };
          return cache;
        })
        .catch(() => FALLBACK);
    }
    let canceled = false;
    pending.then((value) => {
      if (!canceled) setBrand(value);
    });
    return () => {
      canceled = true;
    };
  }, []);

  useEffect(() => {
    applyBrand(brand);
  }, [brand]);

  return brand;
}

/** The logo when one is configured, otherwise the wordmark. */
export function BrandMark({ brand, size = 30 }) {
  if (brand.logoUrl) {
    return (
      <img
        className="brand-logo"
        src={brand.logoUrl}
        alt={brand.name}
        style={{ height: size, maxWidth: size * 4.5, objectFit: 'contain' }}
      />
    );
  }
  return (
    <span className="brand-name" aria-label={brand.name}>
      {brand.name}
    </span>
  );
}
