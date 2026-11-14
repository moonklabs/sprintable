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
import { tailwindCandidates } from './support/tailwind-candidates';

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
        import ko from './messages/ko.json'; import en from './messages/en.json';
        import RegisterPage from './src/app/register/page';
        window.__mount = (l) => {
          createRoot(document.getElementById('root')).render(React.createElement(NextIntlClientProvider, { locale: l, messages: l === 'en' ? en : ko, timeZone: 'Asia/Seoul' }, React.createElement(RegisterPage)));
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
  // the class tokens: the quoted strings AND the template literals (a shared part such as the legal footer writes `flex flex-wrap … ${className}` as a template — a scan of quoted strings alone draws it only when the same words happen to stand in a quoted string elsewhere in the bundle)
  const candidates = tailwindCandidates(js);
  const compiler = await compile(readFileSync(path.join(APP, 'globals.css'), 'utf8'), { base: APP, onDependency: () => {} });
  const css = (optimize as unknown as (c: string, o?: object) => { code: string })(compiler.build(candidates), { minify: false }).code;
  built = { js, css };
  return built;
}

async function open(page: Page, width: number, height: number, locale: 'ko' | 'en' = 'ko') {
  const { js, css } = await build();
  await page.setViewportSize({ width, height });
  await page.unrouteAll();
  await page.route('http://preview.test/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/') {
      return route.fulfill({ contentType: 'text/html', body: `<!doctype html><html lang="${locale}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head><body class="bg-background text-foreground"><div id="root"></div></body></html>` });
    }
    return route.fulfill({ status: 404, body: '{}' });
  });
  await page.goto('about:blank');
  await page.goto('http://preview.test/');
  await page.addScriptTag({ content: js });
  await page.evaluate((l) => (window as unknown as { __mount: (l: string) => void }).__mount(l), locale);
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

// story 4891 (PO 11-11) — the consent line on a phone: the box and its words are ONE ≥44 press; the two documents are their own ≥44 links outside that press. Before: the middle of the sentence was a link, so a tap on the words opened the terms and the box stayed off.
test.describe('the consent line on a phone (390 × 844)', () => {
  test.use({ hasTouch: true, isMobile: true });

  test('[SID:4891] the label (box + words) is ≥44 tall; the two links are separate, ≥44 tall, outside the label', async ({ page }) => {
    await open(page, 390, 844);
    const m = await page.evaluate(() => {
      const label = document.querySelector('[data-testid="register-consent"] label') as HTMLElement;
      const card = label.closest('.rounded-2xl') as HTMLElement;
      const lr = label.getBoundingClientRect(); const cr = card.getBoundingClientRect();
      const links = [...document.querySelectorAll('[data-testid="register-consent"] a')].map((a) => { const r = a.getBoundingClientRect(); return { text: a.textContent?.trim(), h: Math.round(r.height), w: Math.round(r.width), insideLabel: label.contains(a), href: a.getAttribute('href'), target: a.getAttribute('target') }; });
      return { labelH: Math.round(lr.height), labelW: Math.round(lr.width), cardInnerW: Math.round(cr.width - 2 * parseFloat(getComputedStyle(card).paddingLeft)), links, labelHasBox: !!label.querySelector('[role="checkbox"]'), labelText: label.textContent?.trim() };
    });
    expect(m.labelHasBox).toBe(true);
    expect(m.labelH, 'the label is a 44 press').toBeGreaterThanOrEqual(44);
    expect(m.labelW, 'the label holds the box and its words').toBeGreaterThan(60);
    expect(m.labelText).toBe('다음에 동의해요:');
    expect(m.links.map((l) => l.text)).toEqual(['이용약관', '개인정보처리방침']);
    for (const l of m.links) {
      expect(l.insideLabel, `${l.text} is not inside the ticking label`).toBe(false);
      expect(l.h, `${l.text} is a 44 press`).toBeGreaterThanOrEqual(44);
      expect(l.target).toBe('_blank');
    }
    expect(m.links.map((l) => l.href)).toEqual(['/terms', '/privacy']);
  });

  test('[SID:4891] a tap on the middle of the words ticks the box and opens nothing; a tap on a document link opens it and does not tick', async ({ page, context }) => {
    await open(page, 390, 844);
    const box = page.getByRole('checkbox');
    await expect(box).toHaveAttribute('aria-checked', 'false');
    const lb = (await page.locator('[data-testid="register-consent"] label').boundingBox())!;
    await page.touchscreen.tap(lb.x + lb.width * 0.6, lb.y + lb.height / 2); // the words, not the box
    await expect(box).toHaveAttribute('aria-checked', 'true');
    expect(context.pages()).toHaveLength(1);
    await page.touchscreen.tap(lb.x + lb.width * 0.6, lb.y + lb.height / 2);
    await expect(box).toHaveAttribute('aria-checked', 'false');
    const popup = page.waitForEvent('popup');
    await page.locator('[data-testid="register-consent"]').getByRole('link', { name: '이용약관' }).tap();
    await popup;
    await expect(box).toHaveAttribute('aria-checked', 'false');
  });
});

// story 4891 (dev «후» 11-11): the English screen is longer than the Korean one — on dev (en-US) the page was 864 px on a 844 px phone (the consent row + the documents wrapped); the one-screen rule holds in BOTH languages.
test.describe('the same one screen in English (390 × 844)', () => {
  test.use({ hasTouch: true, isMobile: true });
  test('[SID:4891] en: the terms line, Google, the three fields, [Sign up] and the footer links are all on the first screen — no scroll', async ({ page }) => {
    await open(page, 390, 844, 'en');
    const m = await where(page);
    expect(m.submit!.bottom, `the sign-up button ends at ${m.submit!.bottom}px of a ${m.vh}px screen`).toBeLessThanOrEqual(m.vh);
    expect(m.docH, `the page is ${m.docH}px on a ${m.vh}px screen`).toBeLessThanOrEqual(m.vh + 1);
    expect(m.overflowX).toBe(false);
  });

  // dev's real fonts are wider than this harness's: the footer's business-info lines wrap more there (dev 11-11: footer 158 px → page 864 on a 844 screen). The harness page must therefore leave slack, not just fit.
  test('[SID:4891] en + ko: the page leaves ≥ 24 px of slack under the one screen (a wider real font wraps the footer more)', async ({ page }) => {
    for (const locale of ['en', 'ko'] as const) {
      await open(page, 390, 844, locale);
      // the page fills the screen (min-h-screen), so its own height says nothing — the content's extent is what counts: the footer's bottom edge + the page's bottom padding
      const content = await page.evaluate(() => { const root = document.querySelector('[data-testid="register-consent"]')!.closest('.min-h-screen') as HTMLElement; const last = root.lastElementChild as HTMLElement; return Math.round(last.getBoundingClientRect().bottom + scrollY + parseFloat(getComputedStyle(root).paddingBottom)); });
      const m = await where(page);
      expect(content, `${locale}: the content ends at ${content}px of a ${m.vh}px screen`).toBeLessThanOrEqual(m.vh - 24);
    }
  });
});
