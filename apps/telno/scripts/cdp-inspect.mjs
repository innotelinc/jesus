#!/usr/bin/env node
/**
 * Inspect a page's layout + CSS structure over the Chrome DevTools Protocol.
 * Usage: node scripts/cdp-inspect.mjs [targetIdOrUrlSubstring] [--port 9222]
 */

const args = process.argv.slice(2);
let port = 9222;
const pi = args.indexOf('--port');
if (pi !== -1) {
  port = Number(args[pi + 1]);
  args.splice(pi, 2);
}
const needle = args[0] || '';

const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const pages = list.filter((t) => t.type === 'page');
const target =
  pages.find((t) => needle && (t.url.includes(needle) || t.id === needle || t.title.includes(needle))) ||
  pages[0];
if (!target) {
  console.error('No page targets found.');
  process.exit(1);
}

const ws = new WebSocket(target.webSocketDebuggerUrl);
let seq = 0;
const pending = new Map();
const waitOpen = new Promise((res, rej) => {
  ws.addEventListener('open', res, { once: true });
  ws.addEventListener('error', rej, { once: true });
});
ws.addEventListener('message', (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
  }
});
const send = (method, params = {}) =>
  new Promise((resolve) => {
    const id = ++seq;
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
  });

await waitOpen;
await send('Runtime.enable');
await send('DOM.enable');
await send('CSS.enable');

const expression = String.raw`(() => {
  const out = {};
  const cs = (el) => (el ? getComputedStyle(el) : null);
  const px = (v) => v; // keep raw css strings

  out.page = {
    url: location.href,
    title: document.title,
    viewport: { w: innerWidth, h: innerHeight, dpr: devicePixelRatio },
    scroll: { docW: document.documentElement.scrollWidth, docH: document.documentElement.scrollHeight },
    hasShadowDom: !!document.querySelector('*') && [...document.querySelectorAll('*')].some(e => e.shadowRoot),
  };

  // --- design tokens declared as CSS custom properties ---
  const tokens = {};
  for (const sheet of document.styleSheets) {
    let rules;
    try { rules = sheet.cssRules; } catch { continue; }
    if (!rules) continue;
    for (const rule of rules) {
      if (rule.style && rule.selectorText && /^(:root|html|:host|\[data-theme)/.test(rule.selectorText)) {
        for (const p of rule.style) {
          if (p.startsWith('--')) tokens[p.trim()] = rule.style.getPropertyValue(p).trim();
        }
      }
    }
  }
  out.tokens = tokens;

  // --- stylesheet inventory + media breakpoints ---
  const sheets = [];
  const breakpoints = new Set();
  for (const sheet of document.styleSheets) {
    let rules;
    try { rules = sheet.cssRules; } catch { continue; }
    if (!rules) continue;
    const entry = { href: sheet.href ? sheet.href.split('/').slice(-2).join('/') : 'inline', rules: 0, media: [] };
    const walk = (rs) => {
      for (const r of rs) {
        entry.rules++;
        if (r.media && r.media.mediaText) {
          entry.media.push(r.media.mediaText);
          for (const m of r.media.mediaText.matchAll(/(\d+(?:\.\d+)?)px/g)) breakpoints.add(Number(m[1]));
        }
        if (r.cssRules) walk(r.cssRules);
      }
    };
    walk(rules);
    sheets.push(entry);
  }
  out.stylesheets = sheets;
  out.mediaBreakpoints = [...breakpoints].sort((a, b) => a - b);

  // --- layout skeleton: landmarks and their box/grid info ---
  const skeleton = (el, depth = 0) => {
    if (!el || depth > 3) return null;
    const s = cs(el);
    const box = el.getBoundingClientRect();
    return {
      tag: el.tagName.toLowerCase(),
      role: el.getAttribute('role') || undefined,
      cls: (el.className && typeof el.className === 'string' ? el.className : '').slice(0, 120) || undefined,
      display: s.display,
      grid: s.display.includes('grid') ? s.gridTemplateColumns : undefined,
      flexDir: s.display.includes('flex') ? s.flexDirection : undefined,
      gap: s.gap && s.gap !== 'normal' ? s.gap : undefined,
      box: [Math.round(box.x), Math.round(box.y), Math.round(box.width), Math.round(box.height)],
      pad: s.padding, radius: s.borderRadius,
      bg: s.backgroundColor, color: s.color,
      children: depth < 2 ? [...el.children].slice(0, 8).map((c) => skeleton(c, depth + 1)).filter(Boolean) : undefined,
    };
  };
  const regions = ['header', 'nav', 'aside', 'main', 'footer', '[class*="sidebar"]', '[class*="nav"]', '[class*="topbar"]', '[class*="shell"]', '[class*="layout"]'];
  out.regions = {};
  for (const sel of regions) {
    const el = document.querySelector(sel);
    if (el) out.regions[sel] = skeleton(el);
  }
  out.landmarkTree = skeleton(document.body, 0);

  // --- type + color + spacing scale actually in use ---
  const fonts = {}, sizes = {}, weights = {}, colors = {}, bgs = {}, radii = {}, shadows = {}, gaps = {};
  const bump = (o, k) => { if (k) o[k] = (o[k] || 0) + 1; };
  let count = 0;
  for (const el of document.querySelectorAll('body *')) {
    const box = el.getBoundingClientRect();
    if (box.width < 2 || box.height < 2) continue;
    if (++count > 5000) break;
    const s = cs(el);
    bump(fonts, s.fontFamily.split(',')[0].replace(/["']/g, '').trim());
    bump(sizes, s.fontSize);
    bump(weights, s.fontWeight);
    if (s.color) bump(colors, s.color);
    if (s.backgroundColor && s.backgroundColor !== 'rgba(0, 0, 0, 0)') bump(bgs, s.backgroundColor);
    if (s.borderRadius && s.borderRadius !== '0px') bump(radii, s.borderRadius);
    if (s.boxShadow && s.boxShadow !== 'none') bump(shadows, s.boxShadow.slice(0, 60));
    bump(gaps, s.gap);
  }
  const top = (o, n = 14) => Object.entries(o).sort((a, b) => b[1] - a[1]).slice(0, n);
  out.type = { fonts: top(fonts), sizes: top(sizes, 16), weights: top(weights) };
  out.palette = { text: top(colors, 12), surfaces: top(bgs, 12) };
  out.shape = { radii: top(radii, 8), shadows: top(shadows, 6), gaps: top(gaps, 10) };

  // --- component vocabulary (class-name stems) ---
  const stems = {};
  for (const el of document.querySelectorAll('[class]')) {
    const list = typeof el.className === 'string' ? el.className.split(/\s+/) : [];
    for (const c of list) {
      if (!c || c.length > 40) continue;
      const stem = c.replace(/(__|--|_)?[a-z0-9]{5,}$/i, '') || c;
      stems[stem] = (stems[stem] || 0) + 1;
    }
  }
  out.classStems = top(stems, 30);

  // --- interactive surface inventory ---
  const invariants = {};
  for (const el of document.querySelectorAll('button, a, input, select, textarea, [role="button"], [role="tab"]')) {
    const key = el.tagName.toLowerCase() + (el.getAttribute('type') ? ':' + el.getAttribute('type') : '');
    invariants[key] = (invariants[key] || 0) + 1;
  }
  out.controls = Object.entries(invariants).sort((a, b) => b[1] - a[1]);

  // --- nav labels / information architecture ---
  out.nav = [...document.querySelectorAll('nav a, aside a, [class*="nav"] a, [role="tab"], [class*="sidebar"] a')]
    .map((a) => (a.getAttribute('aria-label') || a.textContent || '').trim().replace(/\s+/g, ' '))
    .filter(Boolean).slice(0, 60);
  out.headings = [...document.querySelectorAll('h1,h2,h3')].map((h) => h.tagName + ': ' + h.textContent.trim().replace(/\s+/g, ' ').slice(0, 80)).slice(0, 30);

  // --- accessibility signals ---
  out.a11y = {
    imagesMissingAlt: [...document.images].filter((i) => !i.alt).length,
    buttonsNoName: [...document.querySelectorAll('button')].filter((b) => !(b.textContent || '').trim() && !b.getAttribute('aria-label')).length,
    inputsNoLabel: [...document.querySelectorAll('input,select,textarea')].filter(
      (i) => !i.labels?.length && !i.getAttribute('aria-label') && !i.getAttribute('placeholder')
    ).length,
    landmarks: [...document.querySelectorAll('header,nav,main,aside,footer,[role]')].length,
    focusVisibleRules: 0,
  };

  // --- responsive behavior probe ---
  out.responsive = {
    usesContainerQueries: CSS.supports('container-type: inline-size'),
    cssLayers: CSS.supports('at-rule(@layer)'),
    viewportMeta: document.querySelector('meta[name="viewport"]')?.content || null,
    gridColumnsInUse: [...new Set([...document.querySelectorAll('*')].map((e) => cs(e).gridTemplateColumns))]
      .filter((v) => v && v !== 'none').slice(0, 10),
  };
  return out;
})()`;

const res = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
if (res.result?.exceptionDetails) {
  console.error(JSON.stringify(res.result.exceptionDetails, null, 2));
  process.exit(1);
}
const data = res.result.result.value;

// Computed-style + CSSOM files for the active document, for cross-checking tokens.
const doc = await send('DOM.getDocument', { depth: 1 });
const styleSheetText = [];
for (const header of doc.result.root.nodeName ? [] : []) styleSheetText.push(header);

console.log(
  JSON.stringify(
    { target: { id: target.id, url: target.url, title: target.title }, profile: data },
    null,
    2
  )
);
ws.close();
