/**
 * story 4891 (UI-8 U8 · «로그인 바닥 링크») — the login page measured in Chromium: the real `LoginPage` + the Mac app block (bundled with esbuild, not copied) and the real Tailwind build of globals.css, Google ON, a Mac user agent.
 * Before (dev, AC1): 10 presses on the first screen — the card's own six plus the Mac app card above it (2) and the terms · privacy links inside it (2).
 * The rule under test: the card holds six actions (two fields · [로그인] · [Google] · «비밀번호 찾기» · «가입») and the terms notice stays right under Google (PO 11-10: the Google click is a sign-up road that records the consent); the Mac app's way in and the web sign-up stand UNDER the card; nothing runs sideways.
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
  const candidates = tailwindCandidates(js);
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
    cardPresses: presses(card).filter((e) => !e.closest('[data-testid="login-terms-line"]')).length, noticeLinks: presses(card).filter((e) => !!e.closest('[data-testid="login-terms-line"]')).length, bottomPresses: presses(bottom).length,
    noticeNextToGoogle: (document.querySelector('a[href^="/auth/login?provider=google"]') as HTMLElement | null)?.nextElementSibling?.getAttribute('data-testid') === 'login-terms-line',
    cardBottom: Math.round(cr.bottom + scrollY), bottomTop: Math.round(br.top + scrollY),
    docH: document.documentElement.scrollHeight, vh: innerHeight, overflowX: document.documentElement.scrollWidth > innerWidth + 1,
    macOfferTop: Math.round(((document.querySelector('[data-testid="login-mac-app-offer"]') as HTMLElement).getBoundingClientRect().top) + scrollY),
  };
});

const MAC_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36';

test.describe('on a phone (390 × 844) · a Mac user agent', () => {
  test.use({ hasTouch: true, isMobile: true, userAgent: MAC_UA });

  test('[SID:4891] the card has six actions with the terms notice under Google; the Mac app block is under the card; nothing runs sideways', async ({ page }) => {
    await open(page, 390, 844);
    const m = await where(page);
    // reverted (the Mac app card above the fields · the terms line inside the card) → more than six in the card
    expect(m.cardPresses, 'actions inside the card').toBe(6);
    expect(m.noticeLinks, 'the notice\'s terms and privacy links stay in the card, under Google').toBe(2);
    expect(m.noticeNextToGoogle, 'the terms notice is the next sibling of the Google button').toBe(true);
    expect(m.bottomPresses, 'under the card: the Mac app file + the web sign-up').toBe(2);
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
    expect(m.cardPresses).toBe(6); expect(m.noticeNextToGoogle).toBe(true);
    expect(m.macOfferTop).toBeGreaterThanOrEqual(m.cardBottom);
  });
});

// story 4891 (second piece · the login on the ds parts) — the WHOLE first screen on a touch phone: every press ≥ 44 × 44 (the two fields, [로그인], [Google], the terms and privacy links, «비밀번호를 잊으셨나요?», «회원가입», the Mac app block's two links),
// no visible text under 12 px, every box has a name, no old (non-ds) part drawn, nothing sideways — before a try and after a failed one (the failure line is the ds failed Banner).
// Before (dev, 390 touch): 44-floor misses 4 (이용약관 41 × 14 · 개인정보처리방침 83 × 14 · 비밀번호를 잊으셨나요? 131 × 16 · 회원가입 48 × 16), 2 unnamed boxes (이메일 · 비밀번호), the old `input` part and a hand-made sign-in `<button>`.
const measureAll = (page: Page) => page.evaluate(() => {
  const root = document.querySelector('#root')!;
  const vis = (e: Element) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== 'hidden' && !e.closest('[aria-hidden="true"]'); };
  const presses = [...root.querySelectorAll('button, a[href], input, select, textarea, summary')].filter(vis);
  const small = presses.filter((e) => { const r = e.getBoundingClientRect(); return r.width < 43.5 || r.height < 43.5; }).map((e) => `${(e.getAttribute('aria-label') || e.textContent || e.tagName).trim().slice(0, 18)} ${Math.round(e.getBoundingClientRect().width)}x${Math.round(e.getBoundingClientRect().height)}`);
  const leaves = [...root.querySelectorAll('*')].filter((e) => e.children.length === 0 && (e.textContent || '').trim() && vis(e));
  const tiny = leaves.filter((e) => parseFloat(getComputedStyle(e).fontSize) < 12).map((e) => `${(e.textContent || '').trim().slice(0, 14)} ${getComputedStyle(e).fontSize}`);
  const unnamed = [...root.querySelectorAll('input, select, textarea')].filter(vis).filter((e) => !(e.getAttribute('aria-label') || e.getAttribute('aria-labelledby') || ((e as HTMLInputElement).labels?.length ?? 0) > 0)).map((e) => e.getAttribute('placeholder') || e.tagName);
  const oldSlots = [...root.querySelectorAll('[data-slot]')].map((e) => e.getAttribute('data-slot')!).filter((s) => !s.startsWith('ds-'));
  const rawButtons = [...root.querySelectorAll('button')].filter(vis).filter((e) => !e.getAttribute('data-slot')).map((e) => (e.textContent || '').trim());
  return { presses: presses.length, small, tiny, unnamed, oldSlots, rawButtons, overflowX: document.documentElement.scrollWidth > innerWidth + 1 };
});
async function expectLoginClean(page: Page, label: string) {
  const m = await measureAll(page);
  expect(m.small, `${label}: presses under 44 px: ${m.small.join(' · ')}`).toEqual([]);
  expect(m.tiny, `${label}: text under 12 px: ${m.tiny.join(' · ')}`).toEqual([]);
  expect(m.unnamed, `${label}: boxes without a name`).toEqual([]);
  expect(m.oldSlots, `${label}: old (non-ds) parts drawn`).toEqual([]);
  expect(m.rawButtons, `${label}: hand-made buttons`).toEqual([]);
  expect(m.overflowX, `${label}: overflow`).toBe(false);
  return m;
}

test.describe('the whole login on a touch phone (390 × 844) · a Mac user agent', () => {
  test.use({ hasTouch: true, isMobile: true, userAgent: MAC_UA });

  test('[SID:4891] every press is ≥ 44, every box named, nothing old — before a try and after a failed one', async ({ page }) => {
    await open(page, 390, 844);
    const m = await expectLoginClean(page, 'login');
    expect(m.presses).toBeGreaterThanOrEqual(10); // 2 fields · [로그인] · [Google] · 2 notice links · 비밀번호 찾기 · 가입 · 2 Mac app links (+ the legal footer links)
    await page.getByRole('textbox', { name: '이메일' }).fill('a@b.co');
    await page.getByRole('textbox', { name: '비밀번호' }).fill('pw');
    await page.getByRole('button', { name: '로그인', exact: true }).tap();
    await expect(page.getByRole('alert')).toContainText('로그인에 실패했어요');
    await expectLoginClean(page, 'login after a failed try');
  });
});
