/**
 * story 4891 (UI-8 U8 · «로그인 바닥 링크») — the login page measured in Chromium: the real `LoginPage` + the Mac app block (bundled with esbuild, not copied) and the real Tailwind build of globals.css, Google ON, a Mac user agent.
 * Before (dev, AC1): 10 presses on the first screen — the card's own six plus the Mac app card above it (2) and the terms · privacy links inside it (2).
 * The rule under test: the card holds six presses (two fields · [로그인] · [Google] · «비밀번호 찾기» · «가입»); the Mac app's way in, the web sign-up and the terms line stand UNDER it; nothing runs sideways.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { expect, test, type Page } from '@playwright/test';
import { compile, optimize } from '@tailwindcss/node';
import { layoutStubPlugin } from './support/layout-stubs';

const req = createRequire(__filename);
const WEB = path.join(__dirname, '..');
const APP = path.join(WEB, 'src', 'app');

let built: { js: string; css: string } | null = null;
async function build() {
  if (built) return built;
  const esbuild = req('esbuild') as typeof import('esbuild');
  const bodies: Record<string, string> = {
    '@/lib/db/client': "export const fetchWithAuth = (u, i) => fetch(u, i); export const loginWithPassword = async () => ({ data: null, error: { code: 'X', message: 'x' } });",
    'next/navigation': "export function useRouter() { return { push() {}, replace() {}, back() {}, refresh() {}, prefetch() {} }; } export function useSearchParams() { return new URLSearchParams(''); } export function usePathname() { return '/login'; }",
  };
  const filter = new RegExp(`^(${Object.keys(bodies).map((k) => k.replace(/[/.-]/g, '\\$&')).join('|')})$`);
  const out = await esbuild.build({
    stdin: {
      contents: `
        import React from 'react'; import { createRoot } from 'react-dom/client'; import { NextIntlClientProvider } from 'next-intl';
        import ko from './messages/ko.json';
        import LoginPage from './src/app/login/page';
        import { MacAppOfferProvider } from './src/app/login/mac-app-offer';
        window.__mount = () => {
          createRoot(document.getElementById('root')).render(React.createElement(NextIntlClientProvider, { locale: 'ko', messages: ko, timeZone: 'Asia/Seoul' }, React.createElement(MacAppOfferProvider, { enabled: true }, React.createElement(LoginPage))));
        };`,
      resolveDir: WEB, loader: 'tsx',
    },
    bundle: true, format: 'iife', platform: 'browser', write: false, logLevel: 'silent', jsx: 'automatic',
    tsconfig: path.join(WEB, 'tsconfig.json'),
    define: { 'process.env.NODE_ENV': '"production"', 'process.env.NEXT_PUBLIC_APP_URL': '"https://app.sprintable.ai"', 'process.env.NEXT_PUBLIC_OAUTH_ENABLED': '"true"' },
    plugins: [
      { name: 'login-4891-stubs', setup(b) {
        b.onResolve({ filter }, (a) => ({ path: a.path, namespace: 'stub4891l' }));
        b.onLoad({ filter: /.*/, namespace: 'stub4891l' }, (a) => ({ contents: bodies[a.path]!, loader: 'js', resolveDir: WEB }));
      } },
      layoutStubPlugin(),
    ],
  });
  const js = out.outputFiles[0]!.text;
  const candidates = [...new Set([...js.matchAll(/"([^"\n]+)"/g)].flatMap((m) => m[1]!.split(/\s+/)).filter(Boolean))];
  const compiler = await compile(readFileSync(path.join(APP, 'globals.css'), 'utf8'), { base: APP, onDependency: () => {} });
  const css = (optimize as unknown as (c: string, o?: object) => { code: string })(compiler.build(candidates), { minify: false }).code;
  built = { js, css };
  return built;
}

async function open(page: Page, width: number, height: number) {
  const { js, css } = await build();
  await page.setViewportSize({ width, height });
  await page.unrouteAll();
  await page.route('http://preview.test/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/') {
      return route.fulfill({ contentType: 'text/html', body: `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head><body class="bg-background text-foreground"><div id="root"></div></body></html>` });
    }
    return route.fulfill({ status: 404, body: '{}' });
  });
  // the page's other modules read `process.env.NEXT_PUBLIC_*` (the Firebase flag …): an empty env is the answer «not set»
  await page.addInitScript(() => { (window as unknown as { process: unknown }).process = { env: {} }; });
  await page.goto('about:blank');
  await page.goto('http://preview.test/');
  await page.addScriptTag({ content: js });
  await page.evaluate(() => (window as unknown as { __mount: () => void }).__mount());
  await page.getByTestId('login-bottom').waitFor();
  await page.getByTestId('login-mac-app-offer').waitFor();
}


const where = (page: Page) => page.evaluate(() => {
  const vis = (e: Element) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== 'hidden'; };
  const card = document.querySelector('.rounded-2xl') as HTMLElement;
  const bottom = document.querySelector('[data-testid="login-bottom"]') as HTMLElement;
  const presses = (el: Element) => [...el.querySelectorAll('input, button, a[href]')].filter(vis);
  const cr = card.getBoundingClientRect(); const br = bottom.getBoundingClientRect();
  return {
    cardPresses: presses(card).length, bottomPresses: presses(bottom).length,
    cardBottom: Math.round(cr.bottom + scrollY), bottomTop: Math.round(br.top + scrollY),
    docH: document.documentElement.scrollHeight, vh: innerHeight, overflowX: document.documentElement.scrollWidth > innerWidth + 1,
    macOfferTop: Math.round(((document.querySelector('[data-testid="login-mac-app-offer"]') as HTMLElement).getBoundingClientRect().top) + scrollY),
  };
});

const MAC_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36';

test.describe('on a phone (390 × 844) · a Mac user agent', () => {
  test.use({ hasTouch: true, isMobile: true, userAgent: MAC_UA });

  test('[SID:4891] the card has six presses; the Mac app block and the terms line are under it; nothing runs sideways', async ({ page }) => {
    await open(page, 390, 844);
    const m = await where(page);
    // reverted (the Mac app card above the fields · the terms line inside the card) → more than six in the card
    expect(m.cardPresses, 'presses inside the card').toBe(6);
    expect(m.bottomPresses, 'the Mac app (2) + the terms and privacy (2)').toBe(4);
    expect(m.macOfferTop, 'the Mac app block starts below the card').toBeGreaterThanOrEqual(m.cardBottom);
    expect(m.bottomTop).toBeGreaterThanOrEqual(m.cardBottom - 1);
    expect(m.overflowX).toBe(false);
  });
});

test.describe('on a desktop width · a Mac user agent', () => {
  test.use({ userAgent: MAC_UA });
  test('[SID:4891] the same: six in the card, the side paths under it', async ({ page }) => {
    await open(page, 1440, 900);
    const m = await where(page);
    expect(m.cardPresses).toBe(6);
    expect(m.macOfferTop).toBeGreaterThanOrEqual(m.cardBottom);
  });
});
