/**
 * story 4937 (Yuna, 4906 lap 3) — what a person types BEFORE the screen comes alive must still be there after it does. A slow phone shows the server's markup for seconds; React's state is then still the first value, and the first re-render
 * writes `node.value = state` into every controlled field — the typed words vanish; a box ticked before only flipped its hidden input, so the next press «un-ticks» it (no change shown).
 * Measured the way Yuna measured it, without a throttle: the REAL screen is rendered to HTML on the server side (`renderToString`), put into Chromium, typed into / ticked BEFORE `hydrateRoot` (the moment of hydration is chosen by the spec, not by a CPU
 * throttle), then hydrated, then typed into / ticked again — and the fields, the box and the submit button are read. 390 and 1440. The real dev build with a throttled CPU is the dev «후» of the story, not this spec.
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

// next/navigation (a screen that reads the search params needs real answers) and the login's own call are not in the shared stub list: one small plugin in front of them. The search string comes from the screen's entry (`__SEARCH__`).
const stubs = () => ({
  name: 'prehydration-stubs',
  setup(b: import('esbuild').PluginBuild) {
    b.onResolve({ filter: /^(next\/navigation|@\/lib\/db\/client)$/ }, (a) => ({ path: a.path, namespace: 'prehydration-stub' }));
    b.onLoad({ filter: /.*/, namespace: 'prehydration-stub' }, (a) => ({
      contents: a.path === 'next/navigation'
        ? "export const useRouter = () => ({ push() {}, replace() {}, refresh() {}, back() {} }); export const useSearchParams = () => new URLSearchParams(__SEARCH__); export const usePathname = () => '/'; export const redirect = () => {};"
        : "export const fetchWithAuth = (u, i) => fetch(u, i); export const loginWithPassword = async () => ({ ok: false }); export const switchOrg = async () => ({}); export const switchProject = async () => ({});",
      loader: 'js',
    }));
  },
});

const SCREENS = {
  register: { module: './src/app/register/page', name: 'default', props: {} },
  login: { module: './src/app/login/page', name: 'default', props: {} },
  forgot: { module: './src/app/forgot-password/page', name: 'default', props: {} },
  reset: { module: './src/app/reset-password/page', name: 'default', props: {}, search: 'token=abc' },
  mfa: { module: './src/app/mfa/mfa-client', name: 'MfaClient', props: { chatsHref: '/chats' } },
} as const;
type ScreenKey = keyof typeof SCREENS;

const built = new Map<ScreenKey, { js: string; css: string; html: string }>();
async function build(key: ScreenKey) {
  const hit = built.get(key);
  if (hit) return hit;
  const esbuild = req('esbuild') as typeof import('esbuild');
  const common = {
    // (`__SEARCH__`: the screen's query string)
    bundle: true, write: false, logLevel: 'silent' as const, jsx: 'automatic' as const, tsconfig: path.join(WEB, 'tsconfig.json'),
    define: { 'process.env': '{}', __SEARCH__: JSON.stringify((SCREENS[key] as { search?: string }).search ?? ''), 'process.env.NODE_ENV': '"production"', 'process.env.NEXT_PUBLIC_APP_URL': '"https://app.sprintable.ai"', 'process.env.NEXT_PUBLIC_OAUTH_ENABLED': '"false"' },
    plugins: [stubs(), layoutStubPlugin()],
  };
  const spec = SCREENS[key];
  const tree = `React.createElement(NextIntlClientProvider, { locale: 'ko', messages: ko, timeZone: 'Asia/Seoul' }, React.createElement(Screen, ${JSON.stringify(spec.props)}))`;
  const imports = `
    import React from 'react'; import { NextIntlClientProvider } from 'next-intl';
    import ko from './messages/ko.json';
    import ${spec.name === 'default' ? 'Screen' : `{ ${spec.name} as Screen }`} from '${spec.module}';`;
  const client = await esbuild.build({
    ...common, format: 'iife', platform: 'browser',
    stdin: { contents: `${imports} import { hydrateRoot } from 'react-dom/client';
      window.__hydrate = () => { window.__root = hydrateRoot(document.getElementById('root'), ${tree}); window.__hydrated = true; };`, resolveDir: WEB, loader: 'tsx' },
  });
  const server = await esbuild.build({
    ...common, format: 'cjs', platform: 'node',
    stdin: { contents: `${imports} import { renderToString } from 'react-dom/server';
      export const html = () => renderToString(${tree});`, resolveDir: WEB, loader: 'tsx' },
  });
  const mod = { exports: {} as { html: () => string } };
  new Function('module', 'exports', 'require', server.outputFiles[0]!.text)(mod, mod.exports, req);
  const js = client.outputFiles[0]!.text;
  const compiler = await compile(readFileSync(path.join(APP, 'globals.css'), 'utf8'), { base: APP, onDependency: () => {} });
  const css = (optimize as unknown as (c: string, o?: object) => { code: string })(compiler.build(tailwindCandidates(js)), { minify: false }).code;
  const out = { js, css, html: mod.exports.html() };
  built.set(key, out);
  return out;
}

/** the server's markup in the page, the client's code loaded — and NOT yet hydrated: that is the slow phone's first seconds */
async function openServerDrawn(page: Page, key: ScreenKey, width: number) {
  const { js, css, html } = await build(key);
  await page.setViewportSize({ width, height: 844 });
  await page.unrouteAll();
  await page.route('http://preview.test/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head><body style="margin:0"><div id="root">${html}</div></body></html>` });
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ data: {} }) });
  });
  await page.goto('about:blank');
  await page.goto('http://preview.test/');
  await page.addScriptTag({ content: js });
}
async function comeAlive(page: Page) {
  await page.evaluate(() => (window as unknown as { __hydrate: () => void }).__hydrate());
  await page.waitForFunction(() => (window as unknown as { __hydrated?: boolean }).__hydrated === true);
  await page.waitForTimeout(150); // React's first commit and its passive effects
}

const NAME = 'input[autocomplete="name"]';
const EMAIL = 'input[type="email"]';
const PASSWORD = 'input[type="password"]';
const BOX = '[data-slot="ds-checkbox"]';
const BOX_FIELD = '[data-slot="ds-checkbox-field"]';
const SUBMIT = '[data-testid="register-submit"]';
const val = (page: Page, sel: string) => page.locator(sel).inputValue();
const ticked = async (page: Page) => (await page.locator(BOX).getAttribute('aria-checked')) === 'true';
const submitEnabled = async (page: Page) => !(await page.locator(SUBMIT).isDisabled());

for (const width of [390, 1440]) {
  test.describe(`register · ${width} px`, () => {
    test(`[SID:4937] E — name · e-mail · password typed BEFORE it is alive, the terms ticked AFTER: the three fields keep what was typed, the terms are on, the submit is on`, async ({ page }) => {
      await openServerDrawn(page, 'register', width);
      await page.locator(NAME).fill('홍길동 테스트');
      await page.locator(EMAIL).fill('before@example.test');
      await page.locator(PASSWORD).fill('Abcdef1!x');
      await comeAlive(page);
      await page.locator(BOX_FIELD).click();
      expect(await val(page, NAME), 'the name').toBe('홍길동 테스트');
      expect(await val(page, EMAIL), 'the e-mail').toBe('before@example.test');
      expect(await val(page, PASSWORD), 'the password').toBe('Abcdef1!x');
      expect(await ticked(page), 'the terms are on after ONE press').toBe(true);
      expect(await submitEnabled(page), 'the submit matches what is on the screen').toBe(true);
    });

    test(`[SID:4937] D — only the name BEFORE, the e-mail and the password AFTER: the name is still there`, async ({ page }) => {
      await openServerDrawn(page, 'register', width);
      await page.locator(NAME).fill('이름만 먼저');
      await comeAlive(page);
      await page.locator(EMAIL).fill('after@example.test');
      await page.locator(PASSWORD).fill('Abcdef1!x');
      expect(await val(page, NAME), 'the name typed before').toBe('이름만 먼저');
      expect(await submitEnabled(page), 'off until the terms are ticked').toBe(false);
      await page.locator(BOX_FIELD).click();
      expect(await submitEnabled(page), 'on once they are').toBe(true);
    });

    test(`[SID:4937] C — the terms ticked BEFORE (a hidden input only), the fields typed AFTER: the box shows ticked, the submit is on without a second press; one more press un-ticks it, visibly`, async ({ page }) => {
      await openServerDrawn(page, 'register', width);
      await page.locator(BOX_FIELD).click();
      await comeAlive(page);
      expect(await ticked(page), 'the box shows what was ticked').toBe(true);
      await page.locator(NAME).fill('나중에 쓴 이름');
      await page.locator(EMAIL).fill('after@example.test');
      await page.locator(PASSWORD).fill('Abcdef1!x');
      expect(await submitEnabled(page), 'on — no second press on the box').toBe(true);
      await page.locator(BOX_FIELD).click();
      expect(await ticked(page), 'a press after it is alive toggles what is shown').toBe(false);
      expect(await submitEnabled(page)).toBe(false);
    });

    test(`[SID:4937] A — values put in by a browser's auto-fill (a value set with no input event) before it is alive take the same road`, async ({ page }) => {
      await openServerDrawn(page, 'register', width);
      await page.evaluate(([n, e, p]) => {
        const set = (sel: string, v: string) => { (document.querySelector(sel) as HTMLInputElement).value = v; };
        set('input[autocomplete="name"]', n!); set('input[type="email"]', e!); set('input[type="password"]', p!);
      }, ['자동 채움 이름', 'auto@example.test', 'Abcdef1!x']);
      await comeAlive(page);
      await page.locator(BOX_FIELD).click();
      expect(await val(page, NAME)).toBe('자동 채움 이름');
      expect(await val(page, EMAIL)).toBe('auto@example.test');
      expect(await val(page, PASSWORD)).toBe('Abcdef1!x');
      expect(await submitEnabled(page)).toBe(true);
    });

    test(`[SID:4937] what is typed AFTER it is alive is never overwritten by the adoption (nothing is locked, nothing re-read)`, async ({ page }) => {
      await openServerDrawn(page, 'register', width);
      await comeAlive(page);
      await page.locator(NAME).fill('나중에만');
      await page.locator(EMAIL).fill('x@example.test');
      expect(await val(page, NAME)).toBe('나중에만');
      expect(await val(page, EMAIL)).toBe('x@example.test');
    });
  });
}

// the other screens of the same shape (the server draws the fields; they are controlled): login · forgot-password · reset-password · the code of the second step
for (const width of [390, 1440]) {
  test.describe(`other screens · ${width} px`, () => {
    test(`[SID:4937] login — e-mail and password typed BEFORE, one letter more AFTER: the e-mail is still there, the password is what was typed + the letter`, async ({ page }) => {
      await openServerDrawn(page, 'login', width);
      await page.locator(EMAIL).fill('before@example.test');
      await page.locator(PASSWORD).fill('Abcdef1!x');
      await comeAlive(page);
      await page.locator(PASSWORD).press('End');
      await page.keyboard.type('y');
      expect(await val(page, EMAIL), 'the e-mail').toBe('before@example.test');
      expect(await val(page, PASSWORD), 'the password').toBe('Abcdef1!xy');
    });

    test(`[SID:4937] forgot-password — the e-mail typed BEFORE: the submit is on without another key, and the e-mail stays`, async ({ page }) => {
      await openServerDrawn(page, 'forgot', width);
      await page.locator(EMAIL).fill('before@example.test');
      await comeAlive(page);
      expect(await page.locator('button:has-text("재설정 링크 전송")').first().isDisabled(), 'the submit matches what is on the screen').toBe(false);
      expect(await val(page, EMAIL)).toBe('before@example.test');
    });

    test(`[SID:4937] reset-password — the new password typed BEFORE: the submit is on without another key, and the password stays`, async ({ page }) => {
      await openServerDrawn(page, 'reset', width);
      await page.locator(PASSWORD).fill('Abcdef1!x');
      await comeAlive(page);
      expect(await val(page, PASSWORD)).toBe('Abcdef1!x');
      expect(await page.locator('button:has-text("비밀번호 변경")').first().isDisabled(), 'the submit matches what is on the screen').toBe(false);
      await expect(page.getByText('3가지 이상'), 'the rules line shows, as it does for a password typed after it is alive (the field is «touched»)').toBeVisible();
    });

    test(`[SID:4937] the second-step code — typed BEFORE (a letter among the digits): only the digits are taken, the submit follows the count`, async ({ page }) => {
      await openServerDrawn(page, 'mfa', width);
      await page.locator('input[inputmode="numeric"]').fill('12a345');
      await comeAlive(page);
      expect(await page.locator('input[inputmode="numeric"]').inputValue(), 'digits only, as the field keeps them').toBe('12345');
      expect(await page.locator('button:has-text("확인")').first().isDisabled(), 'five digits: off').toBe(true);
      await page.locator('input[inputmode="numeric"]').press('End');
      await page.keyboard.type('6');
      expect(await page.locator('input[inputmode="numeric"]').inputValue()).toBe('123456');
      expect(await page.locator('button:has-text("확인")').first().isDisabled(), 'six digits: on').toBe(false);
    });
  });
}
