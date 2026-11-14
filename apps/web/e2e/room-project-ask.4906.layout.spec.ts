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
        import React from 'react'; import { createRoot } from 'react-dom/client'; import { NextIntlClientProvider } from 'next-intl';
        import ko from './messages/ko.json';
        import { RoomProjectAsk } from './src/components/chat/room-project-ask';
        const PROJECTS = [{ projectId: 'p1', projectName: '발행 시험' }, { projectId: 'p2', projectName: 'walk-p2-202610150848' }, { projectId: 'p3', projectName: 'walk-p2-202611030422' }];
        window.__mount = () => {
          createRoot(document.getElementById('root')).render(React.createElement(NextIntlClientProvider, { locale: 'ko', messages: ko, timeZone: 'Asia/Seoul' },
            React.createElement('div', { id: 'frame', className: 'bg-ds-background' }, React.createElement(RoomProjectAsk, { value: '', projects: PROJECTS, onChange: () => {} }))));
        };`,
      resolveDir: WEB, loader: 'tsx',
    },
    bundle: true, format: 'iife', platform: 'browser', write: false, logLevel: 'silent', jsx: 'automatic',
    tsconfig: path.join(WEB, 'tsconfig.json'),
    define: { 'process.env.NODE_ENV': '"production"', 'process.env.NEXT_PUBLIC_APP_URL': '"https://app.sprintable.ai"' },
    plugins: [layoutStubPlugin()],
  });
  const js = out.outputFiles[0]!.text;
    const candidates = tailwindCandidates(js);
  const compiler = await compile(readFileSync(path.join(APP, 'globals.css'), 'utf8'), { base: APP, onDependency: () => {} });
  const css = (optimize as unknown as (c: string, o?: object) => { code: string })(compiler.build(candidates), { minify: false }).code;
  built = { js, css };
  return built;
}


async function open(page: Page, width: number) {
  const { js, css } = await build();
  await page.setViewportSize({ width, height: 844 });
  await page.unrouteAll();
  await page.route('http://preview.test/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head><body style="margin:0"><div id="root"></div></body></html>` });
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ data: [] }) });
  });
  await page.goto('about:blank'); await page.goto('http://preview.test/');
  await page.addScriptTag({ content: js });
  await page.evaluate(() => (window as unknown as { __mount: () => void }).__mount());
  await page.getByTestId('room-project-ask').waitFor();
}

async function geometry(page: Page) {
  return page.evaluate(() => {
    const r = (e: Element) => { const b = e.getBoundingClientRect(); return { x: b.left, y: b.top, r: b.right, b: b.bottom, w: b.width, h: b.height }; };
    const bar = document.querySelector('[data-testid="room-project-ask"]')!; const label = bar.querySelector('label')!; const sel = bar.querySelector('select')!;
    const cs = getComputedStyle(sel);
    // the width of the selected option's text in the select's own font, against the room the select leaves for it (its inner width minus the native arrow, ~ 24 px)
    const span = document.createElement('span'); span.style.cssText = `position:absolute;visibility:hidden;white-space:pre;font:${cs.font}`; span.textContent = sel.selectedOptions[0]!.text; document.body.appendChild(span);
    const textW = span.getBoundingClientRect().width; span.remove();
    const inner = sel.getBoundingClientRect().width - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight) - parseFloat(cs.borderLeftWidth) - parseFloat(cs.borderRightWidth);
    return { bar: r(bar), label: r(label), sel: r(sel), textW, inner, text: sel.selectedOptions[0]!.text, overflowX: document.documentElement.scrollWidth > innerWidth + 1 };
  });
}

for (const width of [320, 360, 390, 639]) {
  test(`[SID:4906] phone ${width}: the label is the first row, the select UNDER it at the full width and 44 px high — the placeholder is read to its last letter`, async ({ page }) => {
    await open(page, width);
    const g = await geometry(page);
    expect(g.sel.y, 'the select is under the label').toBeGreaterThanOrEqual(g.label.b - 1);
    expect(g.sel.w, `the select takes the bar's width (minus its 16 px sides): ${g.sel.w}`).toBeGreaterThanOrEqual(width - 32 - 2);
    expect(g.sel.h, 'a 44 px press').toBeGreaterThanOrEqual(43.5);
    expect(g.sel.w, 'a 44 px press across too').toBeGreaterThanOrEqual(44);
    expect(g.text, 'the placeholder is the selected text').toBe('프로젝트를 고르세요');
    expect(g.textW, `the placeholder (${Math.round(g.textW)} px) fits the select's inner width (${Math.round(g.inner)} px less the native arrow)`).toBeLessThanOrEqual(g.inner - 24);
    expect(g.overflowX, 'no sideways scroll').toBe(false);
  });
}

for (const width of [640, 1100, 1440]) {
  test(`[SID:4906] ${width}: one row as before — the label left, the select right of it (what the label leaves, up to 320) × 36`, async ({ page }) => {
    await open(page, width);
    const g = await geometry(page);
    expect(g.sel.x, 'the select is right of the label').toBeGreaterThanOrEqual(g.label.r - 1);
    expect(Math.abs((g.sel.y + g.sel.h / 2) - (g.label.y + g.label.h / 2)), 'one line').toBeLessThan(g.sel.h);
    // the label keeps its one 310 px line (`sm:flex-shrink-0`), the select takes what is left up to `max-w-xs` (320): 289 at 640 (as before — the row was always one line), 320 from ~ 666 up
    const left = Math.round(width - 32 - g.label.w - 8);
    expect(Math.abs(Math.round(g.sel.w) - Math.min(320, left)), `the select is ${g.sel.w} wide: what the label leaves (${left}) up to 320`).toBeLessThanOrEqual(1);
    expect(Math.round(g.sel.h), 'and 36 high (h-9)').toBe(36);
  });
}
