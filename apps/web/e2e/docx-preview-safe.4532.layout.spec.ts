/**
 * story #4532 AC5 (Kadir codex · PO 22:19Z): the .docx preview renders into our page with docx-preview. A document can carry an
 * HTML part (altChunk — rendered by default into an UNSANDBOXED srcdoc iframe, which inherits our origin) and a hyperlink whose
 * external target is `javascript:…` (copied into `href` as it is). Both ran script as us.
 *
 * Real render in Chromium: the real docx-preview and the real `src/lib/docx-safe.ts` (bundled here with esbuild — not copied),
 * on a document built here with both. Positive control first (docx-preview's defaults → the altChunk script runs and the link
 * fires), then DocxBody's options + `neutralizeDocxLinks` → no iframe, no script, the link has no address. Reverting either →
 * RED. No server of ours — the page is answered here.
 */
import path from 'node:path';
import { createRequire } from 'node:module';
import { expect, test, type Page } from '@playwright/test';

const req = createRequire(__filename);
const WEB = path.join(__dirname, '..');

async function evilDocx(): Promise<string> {
  const JSZip = req(req.resolve('jszip', { paths: [req.resolve('docx-preview')] })) as typeof import('jszip');
  const zip = new JSZip();
  zip.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="html" ContentType="text/html"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`);
  zip.file('_rels/.rels', `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`);
  zip.file('word/_rels/document.xml.rels', `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rChunk" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/aFChunk" Target="chunk.html"/><Relationship Id="rLink" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="javascript:window.postMessage('LINK','*')" TargetMode="External"/><Relationship Id="rWeb" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.com/" TargetMode="External"/></Relationships>`);
  zip.file('word/chunk.html', '<html><body><script>parent.postMessage("RAN","*")</script>chunk</body></html>');
  zip.file('word/document.xml', `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body><w:p><w:r><w:t>hello</w:t></w:r></w:p><w:altChunk r:id="rChunk"/><w:p><w:hyperlink r:id="rLink"><w:r><w:t>click me</w:t></w:r></w:hyperlink></w:p><w:p><w:hyperlink r:id="rWeb"><w:r><w:t>a web link</w:t></w:r></w:hyperlink></w:p></w:body></w:document>`);
  return zip.generateAsync({ type: 'base64' });
}

async function bundle(): Promise<string> {
  const esbuild = req('esbuild') as typeof import('esbuild');
  const out = await esbuild.build({
    stdin: { contents: `import { renderAsync } from 'docx-preview'; import { DOCX_RENDER_OPTIONS, neutralizeDocxLinks } from './src/lib/docx-safe'; (window as any).__docx = { renderAsync, DOCX_RENDER_OPTIONS, neutralizeDocxLinks };`, resolveDir: WEB, loader: 'ts' },
    bundle: true, format: 'iife', platform: 'browser', write: false, logLevel: 'silent',
  });
  return out.outputFiles[0]!.text;
}

async function render(page: Page, safe: boolean) {
  await page.route('**/docx/', (r) => r.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body><div id="root"></div></body></html>' }));
  await page.goto('http://preview.test/docx/');
  await page.addScriptTag({ content: await bundle() });
  return page.evaluate(async ({ b64, safe }) => {
    type Docx = { renderAsync: (b: ArrayBuffer, root: HTMLElement, s: undefined, o: object) => Promise<unknown>; DOCX_RENDER_OPTIONS: object; neutralizeDocxLinks: (root: ParentNode) => void };
    const d = (window as unknown as { __docx: Docx }).__docx;
    const got: string[] = [];
    // only our two markers (JSZip's setImmediate shim posts messages of its own)
    window.addEventListener('message', (e) => { if (e.data === 'RAN' || e.data === 'LINK') got.push(e.data); });
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const root = document.getElementById('root')!;
    // the control: docx-preview's own defaults (what DocxBody passed before) · the fix: DocxBody's options + the link step
    await d.renderAsync(bytes.buffer, root, undefined, safe ? { ...d.DOCX_RENDER_OPTIONS } : { inWrapper: true, ignoreWidth: true, ignoreHeight: true, breakPages: true });
    if (safe) d.neutralizeDocxLinks(root);
    await new Promise((r) => setTimeout(r, 1000)); // the srcdoc frame's script would have posted by now
    const link = [...root.querySelectorAll('a')].find((a) => a.textContent === 'click me') as HTMLAnchorElement | undefined;
    link?.click();
    await new Promise((r) => setTimeout(r, 300));
    const web = [...root.querySelectorAll('a')].find((a) => a.textContent === 'a web link') as HTMLAnchorElement | undefined;
    return { iframes: root.querySelectorAll('iframe').length, got, linkHref: link?.getAttribute('href') ?? null, webHref: web?.getAttribute('href') ?? null, webTarget: web?.getAttribute('target') ?? null, text: root.textContent?.includes('hello') ?? false };
  }, { b64: await evilDocx(), safe });
}

test('[SID:4532] control — docx-preview\'s defaults: the altChunk HTML runs in an unsandboxed frame and the javascript: link fires (the check can fail)', async ({ page }) => {
  const r = await render(page, false);
  expect(r.text).toBe(true);
  expect(r.iframes).toBe(1);
  expect(r.got).toContain('RAN');
  expect(r.got).toContain('LINK');
});

test('[SID:4532] DocxBody\'s options + neutralizeDocxLinks: no frame, no script, the javascript: link has no address · a web link stays and opens apart', async ({ page }) => {
  const r = await render(page, true);
  expect(r.text).toBe(true);
  expect(r.iframes).toBe(0);
  expect(r.got).toEqual([]);
  expect(r.linkHref).toBeNull();
  expect(r.webHref).toBe('https://example.com/');
  expect(r.webTarget).toBe('_blank');
});
