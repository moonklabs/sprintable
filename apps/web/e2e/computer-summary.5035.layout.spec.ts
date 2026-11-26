/**
 * story 5035 follow-up (PO's Two-Pass on 390) — the «실행 위치» value of the agent detail's summary card, measured in Chromium with the REAL `ComputerSummaryValue`:
 * the sentence breaks only between words (never inside one), the state stays with its «·» (never alone on the next line), a very long device name still wraps inside the box, and the link is one piece.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { expect, test, type Page } from '@playwright/test';
import { compile, optimize } from '@tailwindcss/node';
import { layoutStubPlugin } from './support/layout-stubs';
import { tailwindCandidates } from './support/tailwind-candidates';

const req = createRequire(__filename);
const WEB = path.join(__dirname, '..');
const APP = path.join(WEB, 'src', 'app');

let built: { js: string; css: string } | null = null;
async function build() {
  if (built) return built;
  const esbuild = req('esbuild') as typeof import('esbuild');
  const out = await esbuild.build({
    stdin: {
      contents: `
        import React from 'react'; import { createRoot } from 'react-dom/client';
        import { ComputerSummaryValue } from './src/components/agents/computer-summary-value';
        window.__mount = (cfg) => createRoot(document.getElementById('root')).render(
          React.createElement('div', { 'data-testid': 'box', style: { width: cfg.width, padding: 0 } },
            React.createElement(ComputerSummaryValue, { line: cfg.line, devicesHref: cfg.link ? '/desktop#device=s1' : null, devicesLabel: '연결된 기기 보기' })));`,
      resolveDir: WEB, loader: 'tsx',
    },
    bundle: true, format: 'iife', platform: 'browser', write: false, logLevel: 'silent', jsx: 'automatic',
    tsconfig: path.join(WEB, 'tsconfig.json'), define: { 'process.env.NODE_ENV': '"production"' }, plugins: [layoutStubPlugin()],
  });
  const js = out.outputFiles[0]!.text;
  const compiler = await compile(readFileSync(path.join(APP, 'globals.css'), 'utf8'), { base: APP, onDependency: () => {} });
  const css = (optimize as unknown as (c: string, o?: object) => { code: string })(compiler.build(tailwindCandidates(js)), { minify: false }).code;
  built = { js, css };
  return built;
}

async function open(page: Page, cfg: { width: number; line: string; link?: boolean }) {
  const { js, css } = await build();
  await page.setViewportSize({ width: 600, height: 600 });
  await page.route('http://preview.test/**', (route) => route.fulfill({ contentType: 'text/html', body: `<!doctype html><html lang="ko"><head><meta charset="utf-8"><style>${css}</style></head><body class="bg-ds-background text-ds-ink"><div id="root"></div></body></html>` }));
  await page.goto('http://preview.test/');
  await page.addScriptTag({ content: js });
  await page.evaluate((c) => (window as unknown as { __mount: (c: unknown) => void }).__mount(c), cfg);
  await page.locator('[data-testid="agent-running-on-line"]').waitFor();
}

/** the line each word sits on (a word is a run between ordinary spaces; a no-break space does not separate words): a word on two lines = broken in the middle */
const wordsOnTwoLines = (page: Page) => page.evaluate(() => {
  const el = document.querySelector('[data-testid="agent-running-on-line"]') as HTMLElement;
  const broken: string[] = [];
  const tops: Record<string, number> = {};
  // every ordinary-space word of the sentence, across the head text and the tail piece
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode() as Text | null; n; n = walker.nextNode() as Text | null) {
    let i = 0;
    for (const word of n.data.split(' ')) {
      if (word.length > 0) {
        const r = document.createRange(); r.setStart(n, i); r.setEnd(n, i + word.length);
        const lines = new Set(Array.from(r.getClientRects()).map((x) => Math.round(x.top)));
        if (lines.size > 1 && word.length < 20) broken.push(word);
        tops[word] = Math.round(r.getBoundingClientRect().top);
      }
      i += word.length + 1;
    }
  }
  return { broken, tops };
});

test('[SID:5035] at every width from 90 to 240px: no word is broken in the middle, and the state stays on the line of its «·» (never alone on the next line)', async ({ page }) => {
  await open(page, { width: 240, line: '지금 도는 컴퓨터: Studio Mac · 끝' });
  for (let w = 90; w <= 240; w += 10) {
    await page.evaluate((width) => { (document.querySelector('[data-testid="box"]') as HTMLElement).style.width = `${width}px`; }, w);
    const r = await wordsOnTwoLines(page);
    expect(r.broken, `width ${w}: a word split across two lines`).toEqual([]);
    // the «·» and the state sit on ONE line (the tail is one unbreakable piece): both words have the same top
    expect(r.tops['·'], `width ${w}: the «·» and the state are on the same line`).toBe(r.tops['끝']);
  }
});

test('[SID:5035] 120px box: a very long device name wraps inside the box (nothing sticks out), the link stays one piece', async ({ page }) => {
  await open(page, { width: 120, line: '지금 도는 컴퓨터: a-very-long-computer-name-without-any-space-0123456789 · 쉬는 중', link: true });
  const m = await page.evaluate(() => {
    const box = (document.querySelector('[data-testid="box"]') as HTMLElement).getBoundingClientRect();
    const line = (document.querySelector('[data-testid="agent-running-on-line"]') as HTMLElement).getBoundingClientRect();
    const link = document.querySelector('[data-testid="agent-see-devices"]') as HTMLElement;
    const l = link.getBoundingClientRect();
    return { lineRight: Math.round(line.right - box.right), linkLines: Math.round(l.height / parseFloat(getComputedStyle(link).lineHeight)), pageX: document.documentElement.scrollWidth - document.documentElement.clientWidth };
  });
  expect(m.lineRight).toBeLessThanOrEqual(0);
  expect(m.linkLines, 'the link is on one line').toBe(1);
});
