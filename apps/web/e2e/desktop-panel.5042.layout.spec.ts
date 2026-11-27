/**
 * story 5042 (C9) — the work-item tab's page of the desktop app, measured in Chromium with the REAL `PanelStateView` (real ds Banner · Button, the real Tailwind build). The panel's column is as narrow as 280 px
 * (the app's own floor) and as wide as the window: the states a person can see without a story — loading · none · not found · error (with a retry) · a bad address — never scroll sideways and keep their words inside the view.
 * (The story itself is the web's own reading view, which has its own specs; the page only hands it the one id.)
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
const AGENT = '7e0e7cc1-c2b8-4669-bfaa-3b13903fd670';

let built: { js: string; css: string } | null = null;
async function build() {
  if (built) return built;
  const esbuild = req('esbuild') as typeof import('esbuild');
  const out = await esbuild.build({
    stdin: {
      contents: `
        import React from 'react'; import { createRoot } from 'react-dom/client';
        import { NextIntlClientProvider } from 'next-intl';
        import messages from './messages/ko.json';
        import { PanelStateView } from './src/components/desktop-panel/work-item-panel';
        window.__mount = (cfg) => {
          window.__retries = 0;
          createRoot(document.getElementById('root')).render(
            React.createElement(NextIntlClientProvider, { locale: 'ko', messages, timeZone: 'Asia/Seoul' },
              React.createElement(PanelStateView, { agentId: cfg.agentId, state: { phase: cfg.phase }, retry: () => { window.__retries += 1; } })));
        };`,
      resolveDir: WEB, loader: 'tsx',
    },
    bundle: true, format: 'iife', platform: 'browser', write: false, logLevel: 'silent', jsx: 'automatic',
    tsconfig: path.join(WEB, 'tsconfig.json'), define: { 'process.env.NODE_ENV': '"production"' },
    plugins: [layoutStubPlugin()],
  });
  const js = out.outputFiles[0]!.text;
  const compiler = await compile(readFileSync(path.join(APP, 'globals.css'), 'utf8'), { base: APP, onDependency: () => {} });
  const css = (optimize as unknown as (c: string, o?: object) => { code: string })(compiler.build(tailwindCandidates(js)), { minify: false }).code;
  built = { js, css };
  return built;
}

async function open(page: Page, o: { width: number; phase: string; agentId?: string }) {
  const { js, css } = await build();
  await page.setViewportSize({ width: o.width, height: 700 });
  await page.route('http://preview.test/**', (route) => route.fulfill({
    contentType: 'text/html',
    body: `<!doctype html><html lang="ko"><head><meta charset="utf-8"><style>${css}</style></head><body class="bg-ds-background text-ds-ink"><div id="root"></div></body></html>`,
  }));
  await page.goto('http://preview.test/');
  const thrown: string[] = [];
  page.on('pageerror', (e) => thrown.push(e.message));
  await page.addScriptTag({ content: js });
  await page.evaluate((cfg) => (window as unknown as { __mount: (c: unknown) => void }).__mount(cfg), { phase: o.phase, agentId: o.agentId ?? AGENT });
  await page.locator('#root > *').first().waitFor();
  await page.waitForTimeout(100);
  expect(thrown, 'no page error').toEqual([]);
}
const overflowX = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

for (const width of [1440, 390, 320, 280]) {
  for (const [phase, testId, agentId] of [['loading', 'panel-loading', undefined], ['none', 'panel-none', undefined], ['error', 'panel-error', undefined], ['notfound', 'panel-not-found', undefined], ['loading', 'panel-bad-address', '../me']] as const) {
    test(`[SID:5042] ${width}px · ${testId}: nothing scrolls sideways and the words stay inside the view`, async ({ page }) => {
      await open(page, { width, phase, agentId });
      const box = await page.locator(`[data-testid="${testId}"]`).boundingBox();
      expect(box, testId).not.toBeNull();
      expect(await overflowX(page)).toBeLessThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(width + 0.5);
    });
  }
}

test('[SID:5042] the error state\'s retry is a real button the person can press (and it asks the page to read again)', async ({ page }) => {
  await open(page, { width: 280, phase: 'error' });
  const button = page.locator('[data-testid="panel-error"] button');
  expect(await button.count()).toBe(1);
  const b = (await button.boundingBox())!;
  expect(b.x + b.width).toBeLessThanOrEqual(280.5);
  await button.click();
  expect(await page.evaluate(() => (window as unknown as { __retries: number }).__retries)).toBe(1);
});
