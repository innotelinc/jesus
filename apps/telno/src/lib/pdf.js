/**
 * A very small PDF writer.
 *
 * Reports leave this platform as documents a customer can open, forward and
 * print. Pulling in a rendering engine for two pages of Helvetica would cost
 * more than the feature: this builds the PDF object graph directly, with the
 * three base fonts (regular, bold, and Courier for anything that has to line up
 * in columns).
 *
 * Supported on purpose: single-column text with heading/body/mono styles,
 * horizontal rules, automatic pagination, and a footer on every page. Not
 * supported, also on purpose: images, fonts beyond the base fourteen, links,
 * tables with real cells, and anything requiring a layout engine.
 */

const PAGE = { width: 595.28, height: 841.89, margin: 56 };
const FONTS = { regular: 'F1', bold: 'F2', mono: 'F3' };
const SIZES = { title: 20, heading: 13, body: 10.5, fine: 8.5 };

const escape = (text) =>
  String(text)
    // The PDF string syntax has three characters that must be escaped.
    .replace(/\\/g, '\\\\')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)')
    // Anything outside WinAnsi cannot be drawn by a base font; a report with a
    // missing glyph is worse than a report with a plain character in its place.
    .replace(/[^\x20-\x7E]/g, '?');

/** Rough advance width for the base fonts, enough to wrap a line sensibly. */
const widthOf = (text, size, mono) => text.length * size * (mono ? 0.6 : 0.5);

/**
 * Build a PDF from a list of blocks:
 *   { style: 'title' | 'heading' | 'body' | 'fine' | 'mono' | 'rule', text }
 *   { style: 'space', size }
 */
export function buildPdf(blocks, { footer = '' } = {}) {
  const pages = [];
  let current = [];
  let y = PAGE.height - PAGE.margin;

  const newPage = () => {
    if (current.length) pages.push(current);
    current = [];
    y = PAGE.height - PAGE.margin;
  };

  const push = (content) => current.push(content);

  for (const block of blocks) {
    const style = block.style || 'body';
    if (style === 'space') {
      y -= block.size ?? 8;
      continue;
    }
    if (style === 'rule') {
      if (y < PAGE.margin + 20) newPage();
      push(`0.7 w 0.6 0.6 0.6 RG ${PAGE.margin} ${y.toFixed(2)} m ${(PAGE.width - PAGE.margin).toFixed(2)} ${y.toFixed(2)} l S`);
      y -= 14;
      continue;
    }

    const mono = style === 'mono';
    const size = SIZES[style] || SIZES.body;
    const font = mono ? FONTS.mono : style === 'title' || style === 'heading' ? FONTS.bold : FONTS.regular;
    const leading = size * 1.45;
    const maxWidth = PAGE.width - PAGE.margin * 2;

    // Wrap on words for prose, on nothing for mono rows that are already laid out.
    const lines = [];
    if (mono) {
      lines.push(block.text);
    } else {
      let line = '';
      for (const word of String(block.text).split(/\s+/)) {
        const candidate = line ? `${line} ${word}` : word;
        if (widthOf(candidate, size, false) > maxWidth && line) {
          lines.push(line);
          line = word;
        } else {
          line = candidate;
        }
      }
      if (line) lines.push(line);
    }

    for (const text of lines) {
      if (y - leading < PAGE.margin + 18) newPage();
      y -= leading;
      push(`BT /${font} ${size} Tf 1 0 0 1 ${PAGE.margin.toFixed(2)} ${y.toFixed(2)} Tm (${escape(text)}) Tj ET`);
    }
    y -= block.gap ?? 4;
  }
  if (current.length) pages.push(current);
  if (!pages.length) pages.push([]);

  // Objects: 1 catalog, 2 pages, 3+ page/contents pairs, then the three fonts.
  const objects = [];
  const fontIds = {};
  const pageIds = [];
  const contentIds = [];
  const firstFont = 3 + pages.length * 2;
  fontIds.regular = firstFont;
  fontIds.bold = firstFont + 1;
  fontIds.mono = firstFont + 2;
  pages.forEach((_, index) => {
    pageIds.push(3 + index * 2);
    contentIds.push(4 + index * 2);
  });

  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objects[2] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pages.length} >>`;

  pages.forEach((ops, index) => {
    const footerOps = footer
      ? `BT /${FONTS.regular} ${SIZES.fine} Tf 0.45 0.45 0.45 rg 1 0 0 1 ${PAGE.margin.toFixed(2)} ${(PAGE.margin - 18).toFixed(2)} Tm (${escape(
          `${footer} · page ${index + 1} of ${pages.length}`
        )}) Tj ET 0 0 0 rg`
      : '';
    const body = [...ops, footerOps].filter(Boolean).join('\n');
    objects[contentIds[index]] = `<< /Length ${Buffer.byteLength(body, 'latin1')} >>\nstream\n${body}\nendstream`;
    objects[pageIds[index]] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE.width} ${PAGE.height}] ` +
      `/Resources << /Font << /F1 ${fontIds.regular} 0 R /F2 ${fontIds.bold} 0 R /F3 ${fontIds.mono} 0 R >> >> ` +
      `/Contents ${contentIds[index]} 0 R >>`;
  });

  objects[fontIds.regular] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>';
  objects[fontIds.bold] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>';
  objects[fontIds.mono] = '<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>';

  const chunks = ['%PDF-1.4\n%\xE2\xE3\xCF\xD3\n'];
  const offsets = [];
  let cursor = Buffer.byteLength(chunks[0], 'latin1');
  for (let id = 1; id < objects.length; id += 1) {
    if (!objects[id]) continue;
    offsets[id] = cursor;
    const chunk = `${id} 0 obj\n${objects[id]}\nendobj\n`;
    chunks.push(chunk);
    cursor += Buffer.byteLength(chunk, 'latin1');
  }

  const xrefStart = cursor;
  const size = objects.length;
  let xref = `xref\n0 ${size}\n0000000000 65535 f \n`;
  for (let id = 1; id < size; id += 1) {
    xref += offsets[id] ? `${String(offsets[id]).padStart(10, '0')} 00000 n \n` : '0000000000 65535 f \n';
  }
  chunks.push(xref);
  chunks.push(`trailer\n<< /Size ${size} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`);

  return Buffer.from(chunks.join(''), 'latin1');
}

/**
 * A money-style report row in columns. Courier is fixed-width, so padded
 * columns line up without a table layout.
 */
export function row(cells, widths) {
  return cells
    .map((cell, index) => String(cell ?? '').padEnd(widths[index] ?? 12).slice(0, widths[index] ?? 12))
    .join(' ')
    .trimEnd();
}
