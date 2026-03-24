import { describe, it, expect } from 'vitest';
import JSZip from 'jszip';
import { extractTheme, extractPlugin } from '../plugin-validator';

function createZipFile(zip: JSZip, name = 'test.zip'): Promise<File> {
  return zip.generateAsync({ type: 'blob' }).then(blob => new File([blob], name));
}

describe('extractTheme', () => {
  it('extracts a valid theme ZIP', async () => {
    const zip = new JSZip();
    zip.file('manifest.json', JSON.stringify({
      id: 'my-theme',
      name: 'My Theme',
      version: '1.0.0',
      author: 'Test',
      type: 'theme',
      variants: ['light', 'dark'],
    }));
    zip.file('theme.css', ':root { --color-primary: #ff0000; }\n.dark { --color-primary: #00ff00; }');

    const file = await createZipFile(zip);
    const result = await extractTheme(file);
    expect(result.valid).toBe(true);
    expect(result.manifest).not.toBeNull();
    expect(result.manifest!.id).toBe('my-theme');
    expect(result.css).toContain('--color-primary');
  });

  it('rejects oversized theme', async () => {
    const zip = new JSZip();
    zip.file('manifest.json', JSON.stringify({
      id: 'big-theme',
      name: 'Big',
      version: '1.0.0',
      author: 'Test',
      type: 'theme',
      variants: ['light'],
    }));
    // Make a large file > 1MB
    zip.file('theme.css', 'x'.repeat(1024 * 1024 + 1));

    // Manually create oversized File
    const oversizedFile = new File([new ArrayBuffer(1024 * 1024 + 1)], 'big.zip');
    const result = await extractTheme(oversizedFile);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('Theme ZIP exceeds 1 MB size limit');
  });

  it('rejects non-ZIP file', async () => {
    const file = new File(['not a zip'], 'bad.zip');
    const result = await extractTheme(file);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('Invalid ZIP file');
  });

  it('rejects missing manifest.json', async () => {
    const zip = new JSZip();
    zip.file('theme.css', ':root { --color-primary: blue; }');
    const file = await createZipFile(zip);
    const result = await extractTheme(file);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('Missing manifest.json');
  });

  it('rejects invalid JSON manifest', async () => {
    const zip = new JSZip();
    zip.file('manifest.json', 'not json {{{');
    zip.file('theme.css', ':root { --color-primary: blue; }');
    const file = await createZipFile(zip);
    const result = await extractTheme(file);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('Invalid manifest.json (not valid JSON)');
  });

  it('rejects missing theme.css', async () => {
    const zip = new JSZip();
    zip.file('manifest.json', JSON.stringify({
      id: 'no-css',
      name: 'No CSS',
      version: '1.0.0',
      author: 'Test',
      type: 'theme',
      variants: ['light'],
    }));
    const file = await createZipFile(zip);
    const result = await extractTheme(file);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('Missing theme.css');
  });

  it('rejects wrong type in manifest', async () => {
    const zip = new JSZip();
    zip.file('manifest.json', JSON.stringify({
      id: 'wrong-type',
      name: 'Wrong',
      version: '1.0.0',
      author: 'Test',
      type: 'plugin', // wrong
      variants: ['light'],
    }));
    zip.file('theme.css', ':root { --color-primary: blue; }');
    const file = await createZipFile(zip);
    const result = await extractTheme(file);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('Expected type "theme"'))).toBe(true);
  });

  it('rejects missing variants', async () => {
    const zip = new JSZip();
    zip.file('manifest.json', JSON.stringify({
      id: 'no-variants',
      name: 'No Variants',
      version: '1.0.0',
      author: 'Test',
      type: 'theme',
    }));
    zip.file('theme.css', ':root { --color-primary: blue; }');
    const file = await createZipFile(zip);
    const result = await extractTheme(file);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('variants'))).toBe(true);
  });

  it('handles ZIP with folder root', async () => {
    const zip = new JSZip();
    const folder = zip.folder('my-theme')!;
    folder.file('manifest.json', JSON.stringify({
      id: 'nested-theme',
      name: 'Nested',
      version: '1.0.0',
      author: 'Test',
      type: 'theme',
      variants: ['light', 'dark'],
    }));
    folder.file('theme.css', ':root { --color-primary: #aaa; }\n.dark { --color-primary: #bbb; }');
    const file = await createZipFile(zip);
    const result = await extractTheme(file);
    expect(result.valid).toBe(true);
    expect(result.manifest!.id).toBe('nested-theme');
  });
});

describe('extractPlugin', () => {
  it('extracts a valid plugin ZIP', async () => {
    const zip = new JSZip();
    zip.file('manifest.json', JSON.stringify({
      id: 'my-plugin',
      name: 'My Plugin',
      version: '1.0.0',
      author: 'Test',
      type: 'ui-extension',
      entrypoint: 'index.js',
      permissions: ['email:read'],
    }));
    zip.file('index.js', 'export function activate(api) { console.log("hi"); }');

    const file = await createZipFile(zip);
    const result = await extractPlugin(file);
    expect(result.valid).toBe(true);
    expect(result.manifest!.id).toBe('my-plugin');
    expect(result.code).toContain('activate');
  });

  it('rejects oversized plugin', async () => {
    const oversizedFile = new File([new ArrayBuffer(5 * 1024 * 1024 + 1)], 'big.zip');
    const result = await extractPlugin(oversizedFile);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('Plugin ZIP exceeds 5 MB size limit');
  });

  it('rejects non-ZIP file', async () => {
    const file = new File(['not a zip'], 'bad.zip');
    const result = await extractPlugin(file);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('Invalid ZIP file');
  });

  it('rejects missing manifest', async () => {
    const zip = new JSZip();
    zip.file('index.js', 'export function activate() {}');
    const file = await createZipFile(zip);
    const result = await extractPlugin(file);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('Missing manifest.json');
  });

  it('rejects disallowed file types', async () => {
    const zip = new JSZip();
    zip.file('manifest.json', JSON.stringify({
      id: 'bad-files',
      name: 'Bad',
      version: '1.0.0',
      author: 'Test',
      type: 'hook',
      entrypoint: 'index.js',
      permissions: [],
    }));
    zip.file('index.js', 'export function activate() {}');
    zip.file('hack.exe', 'binary');

    const file = await createZipFile(zip);
    const result = await extractPlugin(file);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('.exe'))).toBe(true);
  });

  it('rejects unknown permissions', async () => {
    const zip = new JSZip();
    zip.file('manifest.json', JSON.stringify({
      id: 'bad-perms',
      name: 'Bad perms',
      version: '1.0.0',
      author: 'Test',
      type: 'hook',
      entrypoint: 'index.js',
      permissions: ['email:read', 'nuclear:launch'],
    }));
    zip.file('index.js', 'export function activate() {}');

    const file = await createZipFile(zip);
    const result = await extractPlugin(file);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('nuclear:launch'))).toBe(true);
  });

  it('warns about eval() in code', async () => {
    const zip = new JSZip();
    zip.file('manifest.json', JSON.stringify({
      id: 'eval-plugin',
      name: 'Eval',
      version: '1.0.0',
      author: 'Test',
      type: 'hook',
      entrypoint: 'index.js',
      permissions: [],
    }));
    zip.file('index.js', 'export function activate() { eval("alert(1)"); }');

    const file = await createZipFile(zip);
    const result = await extractPlugin(file);
    expect(result.valid).toBe(true);
    expect(result.warnings.some(w => w.includes('eval()'))).toBe(true);
  });

  it('warns about document.cookie in code', async () => {
    const zip = new JSZip();
    zip.file('manifest.json', JSON.stringify({
      id: 'cookie-plugin',
      name: 'Cookie',
      version: '1.0.0',
      author: 'Test',
      type: 'hook',
      entrypoint: 'index.js',
      permissions: [],
    }));
    zip.file('index.js', 'export function activate() { const c = document.cookie; }');

    const file = await createZipFile(zip);
    const result = await extractPlugin(file);
    expect(result.valid).toBe(true);
    expect(result.warnings.some(w => w.includes('document.cookie'))).toBe(true);
  });

  it('rejects invalid plugin type', async () => {
    const zip = new JSZip();
    zip.file('manifest.json', JSON.stringify({
      id: 'bad-type',
      name: 'Bad Type',
      version: '1.0.0',
      author: 'Test',
      type: 'theme', // wrong type for plugin
      entrypoint: 'index.js',
      permissions: [],
    }));
    zip.file('index.js', 'export function activate() {}');

    const file = await createZipFile(zip);
    const result = await extractPlugin(file);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('Invalid type'))).toBe(true);
  });

  it('rejects missing entrypoint', async () => {
    const zip = new JSZip();
    zip.file('manifest.json', JSON.stringify({
      id: 'no-entry',
      name: 'No Entry',
      version: '1.0.0',
      author: 'Test',
      type: 'hook',
      entrypoint: 'main.js',
      permissions: [],
    }));
    zip.file('index.js', 'export function activate() {}');
    // entrypoint 'main.js' doesn't exist

    const file = await createZipFile(zip);
    const result = await extractPlugin(file);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('Missing entrypoint'))).toBe(true);
  });

  it('rejects invalid manifest ID format', async () => {
    const zip = new JSZip();
    zip.file('manifest.json', JSON.stringify({
      id: 'Bad_ID!',
      name: 'Bad ID',
      version: '1.0.0',
      author: 'Test',
      type: 'hook',
      entrypoint: 'index.js',
      permissions: [],
    }));
    zip.file('index.js', 'export function activate() {}');

    const file = await createZipFile(zip);
    const result = await extractPlugin(file);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('ID must be lowercase'))).toBe(true);
  });
});
