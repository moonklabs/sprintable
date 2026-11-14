/**
 * story 4891 (UI-8 · settings › 데스크톱/폰 앱 · piece ④) — the desktop-app download card (with the first-open guide), the phone-app card (QR + store links), the pairing screen (start · confirm · a refusal with «다시 찍기» ·
 * not in the app), the limit-screen phone row and the remote-control links, measured in Chromium on a touch phone (390 × 844): the REAL components (bundled with esbuild, not copied) and the real Tailwind build.
 * Rule: every press is ≥ 44 × 44, no visible text is under 12 px, nothing runs past the width, no old (non-ds) part is drawn; the words, the testids and the handlers are the old ones.
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
  const bodies: Record<string, string> = {
    // the phone app has both stores open → both QR rows are drawn
    '@/lib/phone-app-store': "export const PHONE_APP_PUBLISHED = { android: true, ios: true }; export const PHONE_APP_STORE_ANDROID_TARGET = 'https://play.google.com/store/apps/details?id=x'; export const PHONE_APP_INVITE_ANDROID_TARGET = null; export const PHONE_APP_TEST_GROUP_TARGET = null; export const PHONE_APP_STORE_IOS = 'https://apps.apple.com/app/id1'; export function phoneAppLinks() { return [{ kind: 'store', store: 'android', url: PHONE_APP_STORE_ANDROID_TARGET }, { kind: 'store', store: 'ios', url: PHONE_APP_STORE_IOS }]; }",
    // any https manifest url is «ours» here (the bucket check is the card's own business, tested elsewhere)
    '@/lib/desktop-downloads': "export const DESKTOP_DOWNLOAD_BUCKET_HEADER = 'x-desktop-download-bucket'; export function ourDownloadUrl(u) { return typeof u === 'string' ? u : null; }",
  };
  const filter = new RegExp(`^(${Object.keys(bodies).map((k) => k.replace(/[/.@-]/g, '\\$&')).join('|')})$`);
  const out = await esbuild.build({
    stdin: {
      contents: `
        import React from 'react'; import { createRoot } from 'react-dom/client'; import { NextIntlClientProvider } from 'next-intl';
        import ko from './messages/ko.json';
        import { PhoneBridgeContext } from './src/components/providers/phone-bridge-context';
        import { DesktopDownloadCard } from './src/components/desktop/desktop-download-card';
        import { PhoneAppCard } from './src/components/desktop/phone-app-card';
        import { PhonePairing } from './src/components/desktop/phone-pairing';
        import { LimitPhoneRow } from './src/components/desktop/limit-phone-row';
        import { RemoteControlLink } from './src/components/desktop/remote-off';
        const noop = () => {};
        window.__mount = (scene) => {
          window.__bridge = [];
          window.__rows = [];
          const phoneCall = async (kind) => {
            window.__bridge.push(kind);
            if (kind === 'pair.scan') return window.__scan || { id: 'x', ok: true, offer_id: 'o1', setup_id: 's1', device_name: '민의 맥북 프로', expires_at: '2099-01-01T00:00:00Z' };
            return { id: 'x', ok: false };
          };
          const inApp = scene === 'pairing' || scene === 'limit' || scene === 'phone'; // a real Mac browser is not inside the phone app
          const scenes = {
            mac: [React.createElement(DesktopDownloadCard), React.createElement(PhoneAppCard, { elsewhere: false })],
            phone: [React.createElement(DesktopDownloadCard), React.createElement(PhoneAppCard, { elsewhere: true })],
            pairing: [React.createElement(PhonePairing)],
            'pairing-outside': [React.createElement(PhonePairing)],
            limit: [
              React.createElement('ul', { key: 'a', style: { display: 'grid', gap: '12px', listStyle: 'none', padding: 0 } },
                React.createElement(LimitPhoneRow, { phone: { id: 'p1', label: '민의 Pixel', last_used_at: '2026-11-10T00:00:00Z', pairs: [{ device_name: 'Mac' }] }, asking: false, onAsk: () => window.__rows.push('ask'), onConfirm: noop, onCancel: noop }),
                React.createElement(LimitPhoneRow, { phone: { id: 'p2', label: '민의 iPhone', last_used_at: null, pairs: [] }, asking: true, onAsk: noop, onConfirm: () => window.__rows.push('confirm'), onCancel: () => window.__rows.push('cancel') })),
              React.createElement(RemoteControlLink, { key: 'b', variant: 'button' }), React.createElement(RemoteControlLink, { key: 'c' })],
          };
          createRoot(document.getElementById('root')).render(React.createElement(NextIntlClientProvider, { locale: 'ko', messages: ko, timeZone: 'Asia/Seoul' },
            React.createElement(PhoneBridgeContext.Provider, { value: { inPhoneApp: inApp, phoneCall } },
              React.createElement('div', { style: { padding: '16px', display: 'grid', gap: '12px' } }, ...scenes[scene]))));
        };`,
      resolveDir: WEB, loader: 'tsx',
    },
    bundle: true, format: 'iife', platform: 'browser', write: false, logLevel: 'silent', jsx: 'automatic',
    tsconfig: path.join(WEB, 'tsconfig.json'),
    define: { 'process.env.NODE_ENV': '"production"', 'process.env.NEXT_PUBLIC_APP_URL': '"https://app.sprintable.ai"' },
    plugins: [
      { name: 'desktop-4891-stubs', setup(b) {
        b.onResolve({ filter }, (a) => ({ path: a.path, namespace: 'stub4891d' }));
        b.onLoad({ filter: /.*/, namespace: 'stub4891d' }, (a) => ({ contents: bodies[a.path]!, loader: 'js', resolveDir: WEB }));
      } },
      layoutStubPlugin(),
    ],
  });
  const js = out.outputFiles[0]!.text;
  const candidates = tailwindCandidates(js);
  const compiler = await compile(readFileSync(path.join(APP, 'globals.css'), 'utf8'), { base: APP, onDependency: () => {} });
  const css = (optimize as unknown as (c: string, o?: object) => { code: string })(compiler.build(candidates), { minify: false }).code;
  built = { js, css };
  return built;
}

type Scene = 'mac' | 'phone' | 'pairing' | 'pairing-outside' | 'limit';
async function open(page: Page, scene: Scene, scan?: object) {
  const { js, css } = await build();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.unrouteAll();
  await page.route('http://preview.test/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/') {
      return route.fulfill({ contentType: 'text/html', body: `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head><body class="bg-ds-canvas text-ds-ink"><div id="root"></div></body></html>` });
    }
    if (url.pathname === '/desktop/downloads/macos.json') {
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ product: 'Sprintable Dev Setup', version: '0.2.99', build: 'abc1234', url: 'https://storage.googleapis.com/b/Sprintable.dmg', notarized: false }) });
    }
    return route.fulfill({ status: 404, body: '{}' });
  });
  await page.addInitScript((s) => { (window as unknown as { process: unknown }).process = { env: {} }; if (s) (window as unknown as { __scan: unknown }).__scan = s; }, scan);
  await page.goto('about:blank');
  await page.goto('http://preview.test/');
  await page.addScriptTag({ content: js });
  await page.evaluate((s) => (window as unknown as { __mount: (s: string) => void }).__mount(s), scene);
  await page.locator(scene === 'mac' || scene === 'phone' ? '[data-testid="phone-app-card"]' : scene === 'limit' ? '[data-testid="pairing-limit-phone"]' : scene === 'pairing-outside' ? '[data-testid="phone-app-get"]' : '[data-testid="phone-pairing"]').first().waitFor();
  if (scene === 'mac') await page.locator('[data-testid="desktop-download-button"]').waitFor();
  if (scene === 'phone') await page.locator('[data-testid="desktop-download-open-on-mac"]').waitFor();
}

const measure = (page: Page) => page.evaluate(() => {
  const vis = (e: Element) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== 'hidden'; };
  const presses = [...document.querySelectorAll('button, [role=switch], a[href], input, select, summary')].filter(vis);
  const small = presses.filter((e) => { const r = e.getBoundingClientRect(); return r.width < 43.5 || r.height < 43.5; }).map((e) => `${(e.getAttribute('aria-label') || e.textContent || e.tagName).trim().slice(0, 14)} ${Math.round(e.getBoundingClientRect().width)}x${Math.round(e.getBoundingClientRect().height)}`);
  const leaves = [...document.querySelectorAll('body *')].filter((e) => e.children.length === 0 && (e.textContent || '').trim() && vis(e));
  const tiny = leaves.filter((e) => parseFloat(getComputedStyle(e).fontSize) < 12).map((e) => `${(e.textContent || '').trim().slice(0, 14)} ${getComputedStyle(e).fontSize}`);
  return { presses: presses.length, small, tiny, overflowX: document.documentElement.scrollWidth > innerWidth + 1,
    oldSlots: [...document.querySelectorAll('[data-slot]')].map((e) => e.getAttribute('data-slot')!).filter((s) => !s.startsWith('ds-')), oldClasses: [...document.querySelectorAll('[class]')].filter((e) => /(^|\s)(text-xs|text-sm|text-muted-foreground|text-foreground)(\s|$)/.test(e.getAttribute('class') || '')).map((e) => (e.getAttribute('class') || '').slice(0, 60)) };
});
async function expectClean(page: Page, label: string) {
  const m = await measure(page);
  // reverted (28 px small buttons · 14/12 px text-sm/text-xs lines · the old Alert/Card) → the lists are not empty
  expect(m.small, `${label}: presses under 44 px: ${m.small.join(' · ')}`).toEqual([]);
  expect(m.tiny, `${label}: text under 12 px: ${m.tiny.join(' · ')}`).toEqual([]);
  expect(m.overflowX, `${label}: overflow`).toBe(false);
  expect(m.oldSlots, `${label}: old (non-ds) parts drawn`).toEqual([]);
  expect(m.oldClasses, `${label}: old text classes drawn`).toEqual([]);
  return m;
}

const MAC_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15';

test.describe('on a touch phone (390 × 844)', () => {
  test.use({ hasTouch: true, isMobile: true });

  test('[SID:4891] a narrow Mac window: the download card (first-open guide + [다운로드]) and the phone-app card (two QR links) stand clean', async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, userAgent: MAC_UA });
    const page = await ctx.newPage();
    await open(page, 'mac');
    const m = await expectClean(page, 'mac');
    expect(await page.locator('[data-testid="desktop-download-gatekeeper-title"]').count(), 'the first-open guide is drawn (un-notarized build)').toBe(1);
    expect(await page.locator('[data-testid="phone-app-link-android"], [data-testid="phone-app-link-ios"]').count(), 'both store rows').toBe(2);
    expect(m.presses, 'the download button + two store links').toBe(3);
    await ctx.close();
  });

  test('[SID:4891] not a Mac (a phone browser): the «open on a Mac» line, the phone-app card with the Mac aux line', async ({ page }) => {
    await open(page, 'phone');
    await expectClean(page, 'phone');
    expect(await page.locator('[data-testid="desktop-download-button"]').count()).toBe(0);
    await expect(page.locator('[data-testid="phone-app-mac-aux"]')).toBeVisible();
  });

  test('[SID:4891] the pairing screen: start → scan → «이 컴퓨터와 짝지을까요?» with [페어링] / [취소]; a refused scan → the line + [다시 찍기]; outside the app → the line + the store rows', async ({ page }) => {
    await open(page, 'pairing');
    await expectClean(page, 'pairing start');
    await page.getByRole('button').first().tap();
    await page.getByRole('button', { name: '취소' }).waitFor();
    await expectClean(page, 'pairing confirm');
    expect(await page.getByRole('button').count()).toBe(2);
    // [페어링] leaves the confirm screen and asks the shell for the next step (the scripted bridge refuses everything but the scan → a refusal line + [다시 찍기])
    await page.getByRole('button', { name: '페어링', exact: true }).tap();
    await page.locator('[data-testid="phone-pairing-line"]').waitFor();
    expect(await page.getByRole('button', { name: '취소' }).count(), 'the confirm screen is gone').toBe(0);
    expect((await page.evaluate(() => (window as unknown as { __bridge: string[] }).__bridge)).length, 'the shell was asked beyond the scan').toBeGreaterThan(1);
    await expectClean(page, 'pairing after [페어링]');
    await open(page, 'pairing', { id: 'x', ok: false, code: 'expired' });
    await page.getByRole('button').first().tap();
    await page.locator('[data-testid="phone-pairing-line"]').waitFor();
    await expectClean(page, 'pairing refused');
    await open(page, 'pairing-outside');
    await expectClean(page, 'pairing outside the app');
    expect(await page.locator('[data-testid="phone-app-get"]').count()).toBe(1);
  });

  test('[SID:4891] the limit screen\'s phone rows (plain · asking «빼기?» with the one confirm) and the two remote-control links stand clean', async ({ page }) => {
    await open(page, 'limit');
    const m = await expectClean(page, 'limit rows');
    expect(m.presses, '[이 폰 빼기] + [빼기][취소] + the button link + the text link').toBe(5);
    // the presses still reach their handlers
    await page.getByRole('button', { name: '이 폰 빼기' }).first().tap();
    await page.getByRole('button', { name: '취소' }).tap();
    await page.getByRole('button', { name: '이 폰 빼기' }).last().tap();
    expect(await page.evaluate(() => (window as unknown as { __rows: string[] }).__rows)).toEqual(['ask', 'cancel', 'confirm']);
  });
});
