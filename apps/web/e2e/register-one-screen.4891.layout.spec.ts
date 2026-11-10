/**
 * story 4891 (UI-8 U1 · «한 화면 가입») — the sign-up page measured in Chromium: the real `RegisterPage` (bundled with esbuild, not copied) and the real Tailwind build of globals.css, Google ON (the dev / prod build).
 * Before: Google first, the e-mail form FOLDED behind [이메일로 가입] — the three fields were a press away (taps: terms · open the fold · sign up = 3 on this page, 4 with the way in from /login).
 * The rule under test, on a phone (390 × 844): the terms line, [Google로 계속], the three fields and [회원가입] are ALL on the first screen — no scroll, no fold button — Google above the fields, nothing runs sideways.
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
    'next/navigation': "export function useRouter() { return { push() {}, replace() {}, back() {}, refresh() {}, prefetch() {} }; } export function useSearchParams() { return new URLSearchParams(''); } export function usePathname() { return '/register'; }",
  };
  const filter = new RegExp(`^(${Object.keys(bodies).map((k) => k.replace(/[/.-]/g, '\\$&')).join('|')})$`);
  const out = await esbuild.build({
    stdin: {
      contents: `
        import React from 'react'; import { createRoot } from 'react-dom/client'; import { NextIntlClientProvider } from 'next-intl';
        import ko from './messages/ko.json';
        import RegisterPage from './src/app/register/page';
        window.__mount = () => {
          createRoot(document.getElementById('root')).render(React.createElement(NextIntlClientProvider, { locale: 'ko', messages: ko, timeZone: 'Asia/Seoul' }, React.createElement(RegisterPage)));
        };`,
      resolveDir: WEB, loader: 'tsx',
    },
    bundle: true, format: 'iife', platform: 'browser', write: false, logLevel: 'silent', jsx: 'automatic',
    tsconfig: path.join(WEB, 'tsconfig.json'),
    define: { 'process.env.NODE_ENV': '"production"', 'process.env.NEXT_PUBLIC_APP_URL': '"https://app.sprintable.ai"', 'process.env.NEXT_PUBLIC_OAUTH_ENABLED': '"true"' },
    plugins: [
      { name: 'register-4891-stubs', setup(b) {
        b.onResolve({ filter }, (a) => ({ path: a.path, namespace: 'stub4891r' }));
        b.onLoad({ filter: /.*/, namespace: 'stub4891r' }, (a) => ({ contents: bodies[a.path]!, loader: 'js', resolveDir: WEB }));
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
  await page.goto('about:blank');
  await page.goto('http://preview.test/');
  await page.addScriptTag({ content: js });
  await page.evaluate(() => (window as unknown as { __mount: () => void }).__mount());
  await page.getByTestId('register-submit').waitFor();
}

/** where each part of the page sits, in page pixels from the top (the page scrolls as a whole) */
const where = (page: Page) => page.evaluate(() => {
  const top = (sel: string) => { const e = document.querySelector(sel) as HTMLElement | null; if (!e) return null; const r = e.getBoundingClientRect(); return { top: Math.round(r.top + scrollY), bottom: Math.round(r.bottom + scrollY) }; };
  return {
    terms: top('label'), google: top('[data-testid="register-google"]'), form: top('[data-testid="register-email-form"]'), submit: top('[data-testid="register-submit"]'),
    foldButton: !!document.querySelector('[data-testid="register-email-open"]'),
    // only what is DRAWN counts (a hidden form is not «on the screen»)
    inputs: [...document.querySelectorAll('input[type="text"], input[type="email"], input[type="password"]')].filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== 'hidden'; }).length,
    submitDrawn: (() => { const e = document.querySelector('[data-testid="register-submit"]'); if (!e) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; })(),
    docH: document.documentElement.scrollHeight, vw: innerWidth, vh: innerHeight, overflowX: document.documentElement.scrollWidth > innerWidth + 1,
  };
});

test.describe('on a phone (390 × 844)', () => {
  test.use({ hasTouch: true, isMobile: true });

  test('[SID:4891] the terms line, Google, the three fields and [회원가입] are all on the first screen — no fold, no scroll', async ({ page }) => {
    await open(page, 390, 844);
    const m = await where(page);
    expect(m.foldButton, 'no fold button').toBe(false);
    expect(m.inputs, 'name · e-mail · password are drawn').toBe(3);
    expect(m.submitDrawn, 'the sign-up button is drawn').toBe(true);
    // reverted (the e-mail form folded again) → the fields are not here, and the submit is not drawn at all
    expect(m.submit!.bottom, `the sign-up button ends at ${m.submit!.bottom}px of a ${m.vh}px screen`).toBeLessThanOrEqual(m.vh);
    expect(m.docH, 'the page does not need a scroll').toBeLessThanOrEqual(m.vh + 1);
    expect(m.overflowX).toBe(false);
  });

  test('[SID:4891] the order: terms, then Google (the hero), then the e-mail fields, then [회원가입]', async ({ page }) => {
    await open(page, 390, 844);
    const m = await where(page);
    expect(m.terms!.top).toBeLessThan(m.google!.top);
    expect(m.google!.bottom).toBeLessThanOrEqual(m.form!.top);
    expect(m.form!.bottom).toBeLessThanOrEqual(m.submit!.bottom);
  });
});

test('[SID:4891] on a desktop width the same one screen holds', async ({ page }) => {
  await open(page, 1440, 900);
  const m = await where(page);
  expect(m.foldButton).toBe(false);
  expect(m.submit!.bottom).toBeLessThanOrEqual(m.vh);
});
