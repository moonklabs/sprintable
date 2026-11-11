/**
 * story 4891 (UI-8 · the sign-up screen and the «check your inbox» card) — measured in Chromium on a touch phone (390 × 844): the REAL components (bundled with esbuild, not copied) and the real Tailwind build, Google ON.
 * Before (dev, 390 touch, en-US): /register — 44-floor misses 1 («Sign in» 43 × 16), 3 boxes with no name, the old `checkbox` and `input` parts; the verify card — 2 misses («Resend verification email» 170 × 28 · «Sign up with a different email» 160 × 18), the old `card` and `button`.
 * Rule: every press ≥ 44 × 44, no visible text under 12 px, every box has a name, no old (non-ds) part drawn, nothing sideways — also with the password rule lines open, after a failed try and with each answer of the resend.
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
    '@/lib/db/client': "export const fetchWithAuth = (u, i) => fetch(u, i); export const logoutUser = async () => undefined;",
    'next/navigation': "export function useRouter() { return { push() {}, replace() {}, back() {}, refresh() {}, prefetch() {} }; } export function useSearchParams() { return new URLSearchParams(''); } export function usePathname() { return '/register'; }",
  };
  const filter = new RegExp(`^(${Object.keys(bodies).map((k) => k.replace(/[/.-]/g, '\\$&')).join('|')})$`);
  const out = await esbuild.build({
    stdin: {
      contents: `
        import React from 'react'; import { createRoot } from 'react-dom/client'; import { NextIntlClientProvider } from 'next-intl';
        import ko from './messages/ko.json';
        import RegisterPage from './src/app/register/page';
        import { EmailVerifyGateCard } from './src/components/auth/email-verify-gate';
        window.__mount = (kind, resend) => {
          const node = kind === 'verify'
            ? React.createElement('div', { className: 'flex min-h-screen items-center justify-center bg-ds-background px-4' }, React.createElement('div', { className: 'w-full max-w-md' }, React.createElement(EmailVerifyGateCard, { gate: { kind: 'closed', email: 'jiwoo.a-very-long-address@example-company.com', resend: resend || 'idle', sendAgain() {}, registerAgain() {} } })))
            : React.createElement(RegisterPage);
          createRoot(document.getElementById('root')).render(React.createElement(NextIntlClientProvider, { locale: 'ko', messages: ko, timeZone: 'Asia/Seoul' }, node));
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
  const candidates = [...new Set([...js.matchAll(/"([^"\n]+)"/g), ...js.matchAll(/`([^`]*)`/g)].flatMap((m) => m[1]!.replace(/\$\{[^}]*\}/g, ' ').split(/\s+/)).filter(Boolean))];
  const compiler = await compile(readFileSync(path.join(APP, 'globals.css'), 'utf8'), { base: APP, onDependency: () => {} });
  const css = (optimize as unknown as (c: string, o?: object) => { code: string })(compiler.build(candidates), { minify: false }).code;
  built = { js, css };
  return built;
}

async function open(page: Page, kind: 'register' | 'verify', resend = 'idle') {
  const { js, css } = await build();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.unrouteAll();
  await page.route('http://preview.test/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/') {
      return route.fulfill({ contentType: 'text/html', body: `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head><body class="bg-background text-foreground"><div id="root"></div></body></html>` });
    }
    if (url.pathname === '/api/auth/register') return route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: { code: 'EMAIL_TAKEN', message: 'x' } }) });
    return route.fulfill({ status: 404, body: '{}' });
  });
  await page.addInitScript(() => { (window as unknown as { process: unknown }).process = { env: {} }; });
  await page.goto('about:blank');
  await page.goto('http://preview.test/');
  await page.addScriptTag({ content: js });
  await page.evaluate(([k, r]) => (window as unknown as { __mount: (k: string, r: string) => void }).__mount(k!, r!), [kind, resend]);
  await page.locator(kind === 'register' ? '[data-testid="register-submit"]' : '[data-testid="email-verify-gate"]').waitFor();
}

const measureAll = (page: Page) => page.evaluate(() => {
  const root = document.querySelector('#root')!;
  const vis = (e: Element) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== 'hidden' && !e.closest('[aria-hidden="true"]'); };
  const presses = [...root.querySelectorAll('button, a[href], a[role=link], input, select, textarea, summary, [role=checkbox], label[data-slot="ds-checkbox-field"]')].filter(vis);
  const small = presses.filter((e) => { const r = e.getBoundingClientRect(); return r.width < 43.5 || r.height < 43.5; }).filter((e) => !(e.getAttribute('role') === 'checkbox' && e.closest('label[data-slot="ds-checkbox-field"]'))).map((e) => `${(e.getAttribute('aria-label') || e.textContent || e.tagName).trim().slice(0, 18)} ${Math.round(e.getBoundingClientRect().width)}x${Math.round(e.getBoundingClientRect().height)}`);
  const leaves = [...root.querySelectorAll('*')].filter((e) => e.children.length === 0 && (e.textContent || '').trim() && vis(e));
  const tiny = leaves.filter((e) => parseFloat(getComputedStyle(e).fontSize) < 12).map((e) => `${(e.textContent || '').trim().slice(0, 14)} ${getComputedStyle(e).fontSize}`);
  const unnamed = [...root.querySelectorAll('input, select, textarea, [role=checkbox]')].filter(vis).filter((e) => {
    const lb = e.getAttribute('aria-labelledby');
    return !(e.getAttribute('aria-label') || (lb && lb.split(' ').some((id) => (document.getElementById(id)?.textContent || '').trim())) || ((e as HTMLInputElement).labels?.length ?? 0) > 0);
  }).map((e) => e.getAttribute('placeholder') || e.tagName);
  const oldSlots = [...root.querySelectorAll('[data-slot]')].map((e) => e.getAttribute('data-slot')!).filter((s) => !s.startsWith('ds-'));
  const rawButtons = [...root.querySelectorAll('button')].filter(vis).filter((e) => !e.getAttribute('data-slot')).map((e) => (e.textContent || '').trim());
  return { presses: presses.length, small, tiny, unnamed, oldSlots, rawButtons, overflowX: document.documentElement.scrollWidth > innerWidth + 1 };
});
async function expectClean(page: Page, label: string) {
  const m = await measureAll(page);
  expect(m.small, `${label}: presses under 44 px: ${m.small.join(' · ')}`).toEqual([]);
  expect(m.tiny, `${label}: text under 12 px: ${m.tiny.join(' · ')}`).toEqual([]);
  expect(m.unnamed, `${label}: boxes without a name`).toEqual([]);
  expect(m.oldSlots, `${label}: old (non-ds) parts drawn`).toEqual([]);
  expect(m.rawButtons, `${label}: hand-made buttons`).toEqual([]);
  expect(m.overflowX, `${label}: overflow`).toBe(false);
  return m;
}

test.describe('on a touch phone (390 × 844)', () => {
  test.use({ hasTouch: true, isMobile: true });

  test('[SID:4891] the sign-up screen stands clean: first look · terms ticked with a weak password (rule lines open) · after a failed try', async ({ page }) => {
    await open(page, 'register');
    const m = await expectClean(page, 'register');
    expect(m.presses).toBeGreaterThanOrEqual(8); // the consent words · 2 document links · Google · 3 boxes · [회원가입] · «로그인» (+ the legal footer links)
    await page.locator('[data-testid="register-consent"] label').tap();
    await expect(page.getByRole('checkbox')).toHaveAttribute('aria-checked', 'true');
    await page.getByRole('textbox', { name: '이름' }).fill('지우');
    await page.getByRole('textbox', { name: '이메일' }).fill('a@b.co');
    await page.getByRole('textbox', { name: '비밀번호' }).fill('abc');
    await expect(page.locator('ul li').first()).toBeVisible();
    await expectClean(page, 'register, the password rule lines open');
    await page.getByRole('textbox', { name: '비밀번호' }).fill('Abc123!!');
    await page.getByTestId('register-submit').tap();
    await expect(page.getByRole('alert')).toContainText('이미');
    await expectClean(page, 'register, after a failed try');
  });

  test('[SID:4891] «check your inbox» stands clean: idle · each answer of a resend (sent · limited · failed) · while sending', async ({ page }) => {
    await open(page, 'verify');
    const m = await expectClean(page, 'verify, idle');
    expect(m.presses).toBe(2); // [인증 메일 다시 보내기] · «다른 주소로 가입하기»
    for (const r of ['sending', 'sent', 'limited', 'failed']) {
      await open(page, 'verify', r);
      await expectClean(page, `verify, ${r}`);
    }
  });
});
