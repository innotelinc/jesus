/**
 * Test script for TNEF (winmail.dat) parser.
 *
 * Usage:
 *   npx tsx scripts/test-tnef.ts <path-to-winmail.dat>
 *
 * Outputs:
 *   - tnef-output.html (HTML body or formatted plain text)
 *   - Any extracted attachments saved alongside
 */

import { readFileSync, writeFileSync } from 'fs';
import { resolve, basename } from 'path';
import { parseTnef } from '../lib/tnef';

const inputPath = process.argv[2];
if (!inputPath) {
  console.error('Usage: npx tsx scripts/test-tnef.ts <path-to-winmail.dat>');
  process.exit(1);
}

const fullPath = resolve(inputPath);
console.log(`Reading: ${fullPath}`);

const data = new Uint8Array(readFileSync(fullPath));
console.log(`File size: ${data.byteLength} bytes`);

const result = parseTnef(data);

console.log(`\n=== TNEF Parse Results ===`);
console.log(`Plain text body: ${result.body ? `${result.body.length} chars` : 'none'}`);
console.log(`HTML body: ${result.htmlBody ? `${result.htmlBody.length} chars` : 'none'}`);
console.log(`Attachments: ${result.attachments.length}`);

if (result.attachments.length > 0) {
  console.log(`\nAttachments:`);
  result.attachments.forEach((att, i) => {
    console.log(`  [${i + 1}] ${att.name} (${att.mimeType}, ${att.data.byteLength} bytes)`);
  });
}

// Build output HTML
let htmlContent: string;

const attachmentsList = result.attachments.length > 0
  ? `<h3>Extracted Attachments (${result.attachments.length})</h3>
<table border="1" cellpadding="8" cellspacing="0" style="border-collapse:collapse;font-family:sans-serif;">
<tr style="background:#f0f0f0;"><th>#</th><th>Name</th><th>MIME Type</th><th>Size</th></tr>
${result.attachments.map((att, i) => `<tr><td>${i+1}</td><td>${att.name}</td><td>${att.mimeType}</td><td>${att.data.byteLength} bytes</td></tr>`).join('\n')}
</table>`
  : '<p>No attachments found.</p>';

if (result.htmlBody) {
  htmlContent = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>TNEF Output</title></head>
<body style="font-family:sans-serif;max-width:900px;margin:20px auto;">
<h2 style="color:#333;border-bottom:2px solid #0078d4;padding-bottom:8px;">TNEF Parse Results</h2>
<p><strong>Source:</strong> ${inputPath} (${data.byteLength} bytes)</p>
${attachmentsList}
<h3>HTML Body</h3>
<div style="border:1px solid #ccc;padding:16px;border-radius:4px;background:#fff;">
${result.htmlBody}
</div>
</body></html>`;
} else if (result.body) {
  const escaped = result.body
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  htmlContent = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>TNEF Output</title></head>
<body style="font-family:sans-serif;max-width:900px;margin:20px auto;">
<h2 style="color:#333;border-bottom:2px solid #0078d4;padding-bottom:8px;">TNEF Parse Results</h2>
<p><strong>Source:</strong> ${inputPath} (${data.byteLength} bytes)</p>
${attachmentsList}
<h3>Plain Text Body</h3>
<pre style="font-family:Consolas,monospace;white-space:pre-wrap;line-height:1.6;border:1px solid #ccc;padding:16px;border-radius:4px;background:#fff;">${escaped}</pre>
</body></html>`;
} else {
  htmlContent = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>TNEF Output</title></head>
<body style="font-family:sans-serif;max-width:900px;margin:20px auto;">
<h2 style="color:#333;border-bottom:2px solid #0078d4;padding-bottom:8px;">TNEF Parse Results</h2>
<p><strong>Source:</strong> ${inputPath} (${data.byteLength} bytes)</p>
<p style="color:#666;"><em>No body content found in this TNEF file. The email body is likely in the regular MIME text/plain part.</em></p>
${attachmentsList}
</body></html>`;
}

const outputHtml = resolve('tnef-output.html');
writeFileSync(outputHtml, htmlContent, 'utf-8');
console.log(`\nSaved HTML: ${outputHtml}`);

// Save extracted attachments
result.attachments.forEach((att, i) => {
  const attPath = resolve(`tnef-attachment-${i + 1}-${att.name}`);
  writeFileSync(attPath, att.data);
  console.log(`Saved attachment: ${attPath}`);
});

console.log('\nDone.');
