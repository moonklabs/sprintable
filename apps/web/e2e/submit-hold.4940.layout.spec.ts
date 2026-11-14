/**
 * story 4940 — a form that LEAVES the page on success (sign up · log in · the second-step code) keeps its button locked until the page is left, and one press is one request.
 * Seen on dev with CPU ×4 + Slow 4G: after «회원가입» the button went back to an enabled «회원가입» between the answer and the next screen (≈3 s: a fresh-looking form), and a press in that window sent a second sign-up (409).
 * The REAL screens (register · login · mfa) in Chromium; the server's answers are routed here, `next/navigation`'s push / replace only RECORD the destination (the page is never left, so «locked until the page is left» is what is read), 390 and 1440.
 * The fallback (a navigation that never happens lets go after 15 s) is the hook's unit test (fake timers); not here.
 */
import path from 'node:path';
import { createRequire } from 'node:module';
import { expect, test, type Page } from '@playwright/test';
import { layoutStubPlugin } from './support/layout-stubs';

const req = createRequire(__filename);
const WEB = path.join(__dirname, '..');

// next/navigation + the login's own call are not in the shared stub list: one small plugin in front of them. push / replace write their destination into window.__nav; loginWithPassword answers what the test put in window.__loginOutcome.
const stubs = () => ({
  name: 'submit-hold-stubs',
  setup(b: import('esbuild').PluginBuild) {
    b.onResolve({ filter: /^(next\/navigation|@\/lib\/db\/client|@\/lib\/auth\/firebase-login-flow)$/ }, (a) => ({ path: a.path, namespace: 'submit-hold-stub' }));
    b.onLoad({ filter: /.*/, namespace: 'submit-hold-stub' }, (a) => ({
      contents: a.path === '@/lib/auth/firebase-login-flow'
        ? "export const signInAndExchangeFirebaseSession = async () => { window.__firebaseCalls = (window.__firebaseCalls || 0) + 1; await new Promise((r) => setTimeout(r, 300)); return window.__firebaseOutcome || {}; };"
        : a.path === 'next/navigation'
        ? "const nav = (kind) => (url) => { (window.__nav = window.__nav || []).push(kind + ' ' + url); }; export const useRouter = () => ({ push: nav('push'), replace: nav('replace'), refresh() {}, back() {} }); export const useSearchParams = () => new URLSearchParams(''); export const usePathname = () => '/'; export const redirect = () => {};"
        : "export const fetchWithAuth = (u, i) => fetch(u, i); export const loginWithPassword = async () => { window.__loginCalls = (window.__loginCalls || 0) + 1; await new Promise((r) => setTimeout(r, 300)); return window.__loginOutcome || {}; }; export const switchOrg = async () => ({}); export const switchProject = async () => ({});",
      loader: 'js',
    }));
  },
});

const SCREENS = {
  register: { module: './src/app/register/page', name: 'default', props: {} },
  login: { module: './src/app/login/page', name: 'default', props: {} },
  mfa: { module: './src/app/mfa/mfa-client', name: 'MfaClient', props: { chatsHref: '/chats' } },
} as const;
type ScreenKey = keyof typeof SCREENS;

const built = new Map<ScreenKey, string>();
async function build(key: ScreenKey) {
  const hit = built.get(key);
  if (hit) return hit;
  const esbuild = req('esbuild') as typeof import('esbuild');
  const spec = SCREENS[key];
  const out = await esbuild.build({
    bundle: true, write: false, logLevel: 'silent', jsx: 'automatic', format: 'iife', platform: 'browser', tsconfig: path.join(WEB, 'tsconfig.json'),
    define: { 'process.env': JSON.stringify({ NEXT_PUBLIC_FIREBASE_AUTH_ENABLED: 'true' }) }, // the login's second road (Firebase) is drawn
    plugins: [stubs(), layoutStubPlugin()],
    stdin: {
      contents: `import React from 'react'; import { createRoot } from 'react-dom/client'; import { NextIntlClientProvider } from 'next-intl'; import ko from './messages/ko.json';
        import ${spec.name === 'default' ? 'Screen' : `{ ${spec.name} as Screen }`} from '${spec.module}';
        window.__mount = () => { window.__root = createRoot(document.getElementById('root')); window.__root.render(React.createElement(NextIntlClientProvider, { locale: 'ko', messages: ko, timeZone: 'Asia/Seoul' }, React.createElement(Screen, ${JSON.stringify(spec.props)}))); };
        window.__leave = () => { window.__root.unmount(); document.getElementById('root').innerHTML = ''; };`,
      resolveDir: WEB, loader: 'tsx',
    },
  });
  const js = out.outputFiles[0]!.text;
  built.set(key, js);
  return js;
}

type Answers = { register?: { status: number; body: unknown; delayMs?: number }; me?: { status: number; body: unknown }; verify?: { status: number; body: unknown } };
async function open(page: Page, key: ScreenKey, width: number, answers: Answers, loginOutcome?: unknown, firebaseOutcome?: unknown) {
  const js = await build(key);
  await page.setViewportSize({ width, height: 844 });
  await page.unrouteAll();
  const calls: { register: number; verify: number } = { register: 0, verify: 0 };
  await page.route('http://preview.test/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head><body style="margin:0"><div id="root"></div></body></html>' });
    if (url.pathname === '/api/auth/register') {
      calls.register += 1; const a = answers.register ?? { status: 201, body: { data: { ok: true } } };
      if (a.delayMs) await new Promise((r) => setTimeout(r, a.delayMs));
      return route.fulfill({ status: a.status, contentType: 'application/json', body: JSON.stringify(a.body) });
    }
    if (url.pathname === '/api/me') { const a = answers.me ?? { status: 404, body: {} }; return route.fulfill({ status: a.status, contentType: 'application/json', body: JSON.stringify(a.body) }); }
    if (url.pathname === '/api/auth/2fa/verify') { calls.verify += 1; const a = answers.verify ?? { status: 200, body: { data: { ok: true } } }; await new Promise((r) => setTimeout(r, 300)); return route.fulfill({ status: a.status, contentType: 'application/json', body: JSON.stringify(a.body) }); }
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ data: {} }) });
  });
  await page.goto('about:blank');
  await page.goto('http://preview.test/');
  if (loginOutcome !== undefined) await page.evaluate((o) => { (window as unknown as { __loginOutcome: unknown }).__loginOutcome = o; }, loginOutcome);
  if (firebaseOutcome !== undefined) await page.evaluate((o) => { (window as unknown as { __firebaseOutcome: unknown }).__firebaseOutcome = o; }, firebaseOutcome);
  await page.addScriptTag({ content: js });
  await page.evaluate(() => (window as unknown as { __mount: () => void }).__mount());
  return calls;
}
const nav = (page: Page) => page.evaluate(() => (window as unknown as { __nav?: string[] }).__nav ?? []);
const firebaseCalls = (page: Page) => page.evaluate(() => (window as unknown as { __firebaseCalls?: number }).__firebaseCalls ?? 0);
const loginCalls = (page: Page) => page.evaluate(() => (window as unknown as { __loginCalls?: number }).__loginCalls ?? 0);

const NAME = 'input[autocomplete="name"]'; const EMAIL = 'input[type="email"]'; const PASSWORD = 'input[type="password"]';
const SUBMIT = '[data-testid="register-submit"]'; const BOXF = '[data-slot="ds-checkbox-field"]';
async function fillRegister(page: Page) {
  await page.locator(NAME).fill('홍길동 테스트'); await page.locator(EMAIL).fill('a@example.test'); await page.locator(PASSWORD).fill('Abcdef1!x'); await page.locator(BOXF).click();
}
const loginButton = (page: Page) => page.getByRole('button', { name: /^로그인( 중…)?$/ });
const mfaButton = (page: Page) => page.getByRole('button', { name: /^확인( ?하는 중…)?$/ });

for (const width of [390, 1440]) {
  test.describe(`${width} px`, () => {
    test(`[SID:4940] register — the answer is a success: the button stays «계정 만드는 중…» and locked, the fields stay locked, and nothing a press can do sends a second sign-up`, async ({ page }) => {
      const calls = await open(page, 'register', width, {});
      await fillRegister(page);
      await page.locator(SUBMIT).click();
      await expect(page.locator(SUBMIT)).toHaveText('계정 만드는 중…');
      await expect.poll(() => nav(page)).toEqual(['push /onboarding?signup=1']);
      await page.waitForTimeout(900); // the window that used to hand an enabled «회원가입» back
      await expect(page.locator(SUBMIT)).toHaveText('계정 만드는 중…');
      await expect(page.locator(SUBMIT)).toBeDisabled();
      await expect(page.locator(EMAIL)).toBeDisabled();
      await page.locator(SUBMIT).click({ force: true }).catch(() => {});
      await page.waitForTimeout(300);
      expect(calls.register, 'one sign-up request').toBe(1);
      expect(await nav(page), 'one navigation').toEqual(['push /onboarding?signup=1']);
    });

    test(`[SID:4940] register — the page is left (the screen goes away) and the person comes BACK to it: the button is not left locked, the form is a fresh one`, async ({ page }) => {
      const calls = await open(page, 'register', width, {});
      await fillRegister(page);
      await page.locator(SUBMIT).click();
      await expect(page.locator(SUBMIT)).toHaveText('계정 만드는 중…');
      await page.evaluate(() => (window as unknown as { __leave: () => void }).__leave()); // the screen goes away, as the navigation does
      await expect(page.locator(SUBMIT)).toHaveCount(0);
      await page.evaluate(() => (window as unknown as { __mount: () => void }).__mount()); // «back» draws the screen again
      await expect(page.locator(SUBMIT)).toHaveText('회원가입');
      await expect(page.locator(NAME)).toBeEnabled();
      await expect(page.locator(NAME)).toHaveValue('');
      await fillRegister(page);
      await expect(page.locator(SUBMIT)).toBeEnabled(); // the lock was the page's, not the browser's: a press goes out again (the server's 409 stops a second account)
      await page.locator(SUBMIT).click();
      await expect.poll(() => calls.register).toBe(2);
    });

    test(`[SID:4940] register — a double press in one frame is ONE request`, async ({ page }) => {
      const calls = await open(page, 'register', width, { register: { status: 201, body: { data: { ok: true } }, delayMs: 400 } });
      await fillRegister(page);
      await page.locator(SUBMIT).dblclick();
      await page.waitForTimeout(1200);
      expect(calls.register).toBe(1);
    });

    test(`[SID:4940] register — a refusal (409 e-mail taken) lets go at once: the button is «회원가입» again, the reason is on the screen, and the next press goes out`, async ({ page }) => {
      const calls = await open(page, 'register', width, { register: { status: 409, body: { error: { code: 'EMAIL_TAKEN', message: 'taken' } } } });
      await fillRegister(page);
      await page.locator(SUBMIT).click();
      await expect(page.locator(SUBMIT)).toHaveText('회원가입');
      await expect(page.locator(SUBMIT)).toBeEnabled();
      await expect(page.locator('[role="alert"], [aria-live]').filter({ hasText: /이미|가입/ }).first()).toBeVisible();
      expect(await nav(page)).toEqual([]);
      await page.locator(SUBMIT).click();
      await expect.poll(() => calls.register).toBe(2);
    });

    test(`[SID:4940] login — a success keeps «로그인 중…» locked (no enabled form while the next screen comes), one call; a refusal lets go and says why`, async ({ page }) => {
      await open(page, 'login', width, {}, {});
      await page.locator(EMAIL).fill('a@example.test'); await page.locator(PASSWORD).fill('Abcdef1!x');
      await loginButton(page).click();
      await expect(page.getByRole('button', { name: '로그인 중…' })).toBeDisabled();
      await expect.poll(async () => (await nav(page)).length).toBe(1);
      expect((await nav(page))[0]).toMatch(/^replace \//);
      await page.waitForTimeout(900);
      await expect(page.getByRole('button', { name: '로그인 중…' })).toBeDisabled();
      await expect(page.locator(EMAIL)).toBeDisabled();
      expect(await loginCalls(page)).toBe(1);
    });

    test(`[SID:4940] login — a refusal (wrong password) lets go: «로그인» again, enabled, the next press calls again`, async ({ page }) => {
      await open(page, 'login', width, {}, { error: { code: 'INVALID_CREDENTIALS' } });
      await page.locator(EMAIL).fill('a@example.test'); await page.locator(PASSWORD).fill('wrong-password');
      await loginButton(page).click();
      await expect(page.getByRole('button', { name: '로그인', exact: true })).toBeEnabled();
      await expect(page.getByRole('alert').first()).toBeVisible();
      expect(await nav(page)).toEqual([]);
      await loginButton(page).click();
      await expect.poll(() => loginCalls(page)).toBe(2);
    });

    test(`[SID:4940] login, the Firebase road — a success keeps the button locked (one call, one replace); a refusal lets go`, async ({ page }) => {
      await open(page, 'login', width, {}, undefined, {});
      await page.locator(EMAIL).fill('a@example.test'); await page.locator(PASSWORD).fill('Abcdef1!x');
      await page.getByRole('button', { name: 'Firebase로 로그인' }).click();
      await expect(page.getByRole('button', { name: '로그인 중…' })).toBeDisabled();
      await expect.poll(async () => (await nav(page)).length).toBe(1);
      await page.waitForTimeout(900);
      await expect(page.getByRole('button', { name: '로그인 중…' })).toBeDisabled();
      expect(await firebaseCalls(page)).toBe(1);
    });

    test(`[SID:4940] login, the Firebase road — a refusal lets go: the button is back and the next press calls again`, async ({ page }) => {
      await open(page, 'login', width, {}, undefined, { error: { code: 'NETWORK_ERROR' } });
      await page.locator(EMAIL).fill('a@example.test'); await page.locator(PASSWORD).fill('Abcdef1!x');
      await page.getByRole('button', { name: 'Firebase로 로그인' }).click();
      await expect(page.getByRole('button', { name: 'Firebase로 로그인' })).toBeEnabled();
      expect(await nav(page)).toEqual([]);
      await page.getByRole('button', { name: 'Firebase로 로그인' }).click();
      await expect.poll(() => firebaseCalls(page)).toBe(2);
    });

    test(`[SID:4940] login — «a code is needed» (TOTP_REQUIRED) is not a leaving: it lets go and shows the code field`, async ({ page }) => {
      await open(page, 'login', width, {}, { error: { code: 'TOTP_REQUIRED' } });
      await page.locator(EMAIL).fill('a@example.test'); await page.locator(PASSWORD).fill('Abcdef1!x');
      await loginButton(page).click();
      await expect(page.locator('input[inputmode="numeric"]')).toBeVisible();
      await expect(page.getByRole('button', { name: '로그인', exact: true })).toBeEnabled();
    });

    test(`[SID:4940] the second-step code — a success keeps the button locked until the page is left, one request; a refusal lets go`, async ({ page }) => {
      const calls = await open(page, 'mfa', width, {});
      await page.locator('input[inputmode="numeric"]').fill('123456');
      await mfaButton(page).click();
      await expect.poll(() => nav(page)).toEqual(['push /chats']);
      await page.waitForTimeout(900);
      await expect(page.locator('button:has-text("확인")').first()).toBeDisabled();
      expect(calls.verify).toBe(1);
    });

    test(`[SID:4940] the second-step code — a refusal (wrong code) lets go: the button is enabled again and says why`, async ({ page }) => {
      const calls = await open(page, 'mfa', width, { verify: { status: 400, body: { error: { code: 'INVALID_TOTP', message: 'x' } } } });
      await page.locator('input[inputmode="numeric"]').fill('123456');
      await mfaButton(page).click();
      await expect(page.getByRole('button', { name: '확인', exact: true })).toBeEnabled();
      expect(await nav(page)).toEqual([]);
      await mfaButton(page).click();
      await expect.poll(() => calls.verify).toBe(2);
    });
  });
}
