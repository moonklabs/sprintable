/**
 * story #4532 AC5 (Kadir · PO 21:46Z): an upload named «x.pdf» whose content is HTML (served as text/html — an upload's
 * content_type is whatever the uploader sent) must never run a script when it is previewed. The PDF preview puts a blob into an
 * iframe that cannot be sandboxed (Chromium's PDF viewer does not draw in a sandboxed frame), so the blob's type is what keeps it
 * a PDF: file-viewer.tsx's own `pdfBlob` (read from the source — drift-proof, not copied) runs here in Chromium, on a page that
 * serves that HTML. Reverting `pdfBlob` to `res.blob()` lets the script run → RED.
 * No server of ours — the routes are answered here.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';

const SRC = path.join(__dirname, '../src/components/chat/file-viewer.tsx');

/** the body of `pdfBlob` as file-viewer.tsx writes it (the TypeScript types stripped) */
function pdfBlobSource(): string {
  const src = readFileSync(SRC, 'utf8');
  const m = /export const pdfBlob = async \(res: Response\): Promise<Blob> => (.+);\n/.exec(src);
  if (!m) throw new Error('file-viewer.tsx: pdfBlob not found');
  return `async (res) => ${m[1]}`;
}

test('[SID:4532] an «.pdf» upload that is really HTML: the PDF preview\'s blob runs no script (its type is application/pdf)', async ({ page }) => {
  const evil = '<html><body><script>parent.postMessage("RAN", "*")</script>hi</body></html>';
  await page.route('**/host/', (r) => r.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body></body></html>' }));
  await page.route('**/host/x.pdf', (r) => r.fulfill({ contentType: 'text/html', body: evil })); // the type the uploader claimed
  await page.goto('http://preview.test/host/');
  const got = await page.evaluate(async (fn) => {
    const pdfBlob = (0, eval)(fn) as (r: Response) => Promise<Blob>;
    let ran = false;
    window.addEventListener('message', (e) => { if (e.data === 'RAN') ran = true; });
    const blob = await pdfBlob(await fetch('/host/x.pdf'));
    const f = document.createElement('iframe'); // as PdfBody renders it: no sandbox
    f.src = URL.createObjectURL(blob);
    document.body.append(f);
    await new Promise((r) => setTimeout(r, 1500)); // a script in the frame would have posted by now
    return { type: blob.type, ran };
  }, pdfBlobSource());
  expect(got).toEqual({ type: 'application/pdf', ran: false });
});

test('[SID:4532] the same page with the server\'s type kept (what res.blob() did) — the script DOES run (the check can fail)', async ({ page }) => {
  const evil = '<html><body><script>parent.postMessage("RAN", "*")</script>hi</body></html>';
  await page.route('**/host/', (r) => r.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body></body></html>' }));
  await page.route('**/host/x.pdf', (r) => r.fulfill({ contentType: 'text/html', body: evil }));
  await page.goto('http://preview.test/host/');
  const ran = await page.evaluate(async () => {
    let r = false;
    window.addEventListener('message', (e) => { if (e.data === 'RAN') r = true; });
    const blob = await (await fetch('/host/x.pdf')).blob();
    const f = document.createElement('iframe');
    f.src = URL.createObjectURL(blob);
    document.body.append(f);
    await new Promise((x) => setTimeout(x, 1500));
    return r;
  });
  expect(ran).toBe(true);
});

test('[SID:4532] both PDF paths use pdfBlob — no `.blob()` left in the PDF preview or the converted-slides preview', () => {
  const src = readFileSync(SRC, 'utf8');
  const body = (name: string) => { const i = src.indexOf(`\nfunction ${name}(`); if (i < 0) throw new Error(`${name} not found`); const j = src.indexOf('\nfunction ', i + 1); return src.slice(i, j > 0 ? j : undefined); };
  const pdfBody = body('PdfBody');
  const pptx = body('PptxBody');
  expect(pdfBody).toContain('await pdfBlob(res)');
  expect(pdfBody).not.toMatch(/\bres\.blob\(\)/);
  expect(pptx).toContain('await pdfBlob(pdfRes)');
  expect(pptx).not.toMatch(/\bpdfRes\.blob\(\)/);
});
