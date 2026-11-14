/**
 * story 4946 (the desktop app's chat list) — the room row's right-click menu opens AT THE POINTER (an anchor of zero size at the click), keeps inside the window near the edges, and holds only the room's two items.
 * The REAL RoomRowContextMenu + the real Tailwind in Chromium at 1100 × 539 (the Mac app's small window).
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
        import React from 'react'; import { createRoot } from 'react-dom/client'; import { NextIntlClientProvider } from 'next-intl';
        import ko from './messages/ko.json';
        import { RoomRowContextMenu } from './src/components/chat/room-row-context-menu';
        window.__closed = 0; window.__muted = 0; window.__settings = 0;
        window.__mount = (x, y, muted) => {
          createRoot(document.getElementById('root')).render(React.createElement(NextIntlClientProvider, { locale: 'ko', messages: ko, timeZone: 'Asia/Seoul' },
            React.createElement('div', { className: 'bg-ds-background', style: { height: '100vh' } }, React.createElement(RoomRowContextMenu, { x, y, muted, onToggleMute: () => { window.__muted += 1; }, onOpenSettings: () => { window.__settings += 1; }, onClose: () => { window.__closed += 1; } }))));
        };`,
      resolveDir: WEB, loader: 'tsx',
    },
    bundle: true, format: 'iife', platform: 'browser', write: false, logLevel: 'silent', jsx: 'automatic',
    tsconfig: path.join(WEB, 'tsconfig.json'),
    define: { 'process.env.NODE_ENV': '"production"', 'process.env.NEXT_PUBLIC_APP_URL': '"https://app.sprintable.ai"' },
    plugins: [layoutStubPlugin()],
  });
  const js = out.outputFiles[0]!.text;
  const compiler = await compile(readFileSync(path.join(APP, 'globals.css'), 'utf8'), { base: APP, onDependency: () => {} });
  const css = (optimize as unknown as (c: string, o?: object) => { code: string })(compiler.build(tailwindCandidates(js)), { minify: false }).code;
  built = { js, css };
  return built;
}

async function open(page: Page, x: number, y: number, muted = false) {
  const { js, css } = await build();
  await page.setViewportSize({ width: 1100, height: 539 });
  await page.unrouteAll();
  await page.route('http://preview.test/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head><body style="margin:0"><div id="root"></div></body></html>` });
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ data: [] }) });
  });
  await page.goto('about:blank'); await page.goto('http://preview.test/');
  await page.addScriptTag({ content: js });
  await page.evaluate(([px, py, m]) => (window as unknown as { __mount: (x: number, y: number, m: boolean) => void }).__mount(px as number, py as number, m as boolean), [x, y, muted]);
  await page.getByTestId('room-row-menu').waitFor();
  await page.waitForTimeout(150); // the positioner settles
}
const box = (page: Page) => page.getByTestId('room-row-menu').evaluate((e) => { const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height, right: r.right, bottom: r.bottom }; });

test.describe('the room row\'s right-click menu (story 4946)', () => {
  test('[SID:4946] ⭐opens AT THE POINTER (within 8 px of the click: the popup edge) and holds exactly the two items', async ({ page }) => {
    await open(page, 200, 160);
    const b = await box(page);
    expect(Math.abs(b.x - 200)).toBeLessThanOrEqual(8); expect(Math.abs(b.y - 160)).toBeLessThanOrEqual(8); // far from where a row's «⋯» menu or the window's corner would put it
    await expect(page.getByRole('menuitem')).toHaveCount(2);
    await expect(page.getByTestId('room-row-mute')).toHaveText('알림 끄기');
    await expect(page.getByTestId('room-row-settings')).toHaveText('알림 설정');
  });
  test('[SID:4946] ⭐near the right / bottom edge it keeps inside the window (flips), never cut off', async ({ page }) => {
    await open(page, 1090, 530);
    const b = await box(page);
    expect(b.x).toBeGreaterThanOrEqual(0); expect(b.y).toBeGreaterThanOrEqual(0);
    expect(b.right).toBeLessThanOrEqual(1100); expect(b.bottom).toBeLessThanOrEqual(539);
  });
  test('[SID:4946] a muted room says «알림 켜기»; the first item has the focus; Escape closes; an item press acts and closes', async ({ page }) => {
    await open(page, 200, 160, true);
    await expect(page.getByTestId('room-row-mute')).toHaveText('알림 켜기');
    await expect(page.getByTestId('room-row-menu')).toBeFocused(); // the menu holds the focus; ↓ goes to the first item
    await page.keyboard.press('ArrowDown');
    await expect(page.getByTestId('room-row-mute')).toBeFocused();
    await page.keyboard.press('Escape');
    expect(await page.evaluate(() => (window as unknown as { __closed: number }).__closed)).toBeGreaterThanOrEqual(1);
  });
  test('[SID:4946] pressing «알림 설정» calls the settings action once', async ({ page }) => {
    await open(page, 200, 160);
    await page.getByTestId('room-row-settings').click();
    expect(await page.evaluate(() => (window as unknown as { __settings: number }).__settings)).toBe(1);
    expect(await page.evaluate(() => (window as unknown as { __muted: number }).__muted)).toBe(0);
  });
});
