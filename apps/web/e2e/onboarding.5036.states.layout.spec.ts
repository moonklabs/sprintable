/**
 * story 5036 (C6 · 선생님 지침 6 «상태 토글») — the straight line's screens in each of the six states, at 1440 and 390, on the REAL OnboardingForm (bundled with esbuild — not copied) and the real
 * Tailwind build (harness = onboarding.4668.layout.spec.ts · 4906: no server of ours, the API answers are made here). One place to switch between the states: each scene below is one state of one step.
 *
 *   state \ step     ① project                         ② connect                              ③ first chat
 *   default          the name filled in                the three ways                         «연결됐어요»
 *   loading          [프로젝트 만들기] busy (skeleton    the key way's press making things      [첫 지시 보내기] busy
 *                    of the press: the press is held)  (the other way out waits)
 *   empty            the name cleared: no press        not a Mac: the two app ways say why    —  (nothing to be empty: the step only shows once an agent connected)
 *   error            the press failed · the list       the agent could not be made            —  (a conversation that cannot be opened goes to the landing — pinned in the unit test)
 *                    could not be read
 *   long text        a 50-letter name · a 120-letter   a long organization name chip · en       en
 *                    project name
 *   390 · 1440       every scene runs at both
 *
 * Every scene is also an assertion: the h1 and the strip's state · nothing wider than the viewport · at 390 every press ≥ 44 px, no text under 12 px, no old (non-ds) part drawn.
 * Names `5036-{step}-{state}-{L}-{width}.png`. Files go to CAPTURE_OUT when set, else this test's output folder.
 */
import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { expect, test, type Locator, type Page } from '@playwright/test';
import type { Plugin } from 'esbuild';
import { compile, optimize } from '@tailwindcss/node';
import { layoutStubPlugin } from './support/layout-stubs';
import { tailwindCandidates } from './support/tailwind-candidates';

const req = createRequire(__filename);
const WEB = path.join(__dirname, '..');
const APP = path.join(WEB, 'src', 'app');

function onboardingStubPlugin(): Plugin {
  const bodies: Record<string, string> = {
    '@/hooks/use-flat-href': 'export function useFlatHref() { return (h) => h; } export function withProjectParam(h) { return h; }',
    '@/lib/db/client': 'export const fetchWithAuth = (u, i) => fetch(u, i); export const refreshAuthTokens = async () => ({ data: { ok: true }, error: null }); export const refreshSessionOnce = refreshAuthTokens; export const refreshSessionAfterChange = refreshAuthTokens; export const switchOrg = async () => new Response(JSON.stringify({ data: { ok: true } })); export const switchProject = switchOrg; export const logoutUser = async () => {};',
  };
  const filter = new RegExp(`^(${Object.keys(bodies).map((k) => k.replace(/[/.-]/g, '\\$&')).join('|')})$`);
  return {
    name: 'onboarding-5036-stubs',
    setup(b) {
      b.onResolve({ filter }, (a) => ({ path: a.path, namespace: 'stub5036' }));
      b.onLoad({ filter: /.*/, namespace: 'stub5036' }, (a) => ({ contents: bodies[a.path]!, loader: 'js', resolveDir: WEB }));
    },
  };
}

let built: { js: string; css: string } | null = null;
async function build() {
  if (built) return built;
  const esbuild = req('esbuild') as typeof import('esbuild');
  const out = await esbuild.build({
    stdin: {
      contents: `
        import React from 'react'; import { createRoot } from 'react-dom/client'; import { NextIntlClientProvider } from 'next-intl';
        import ko from './messages/ko.json'; import en from './messages/en.json';
        import { OnboardingForm } from './src/app/onboarding/onboarding-form';
        const h = React.createElement;
        window.__mount = (locale) => {
          const root = createRoot(document.getElementById('root'));
          root.render(h(NextIntlClientProvider, { locale, messages: locale === 'en' ? en : ko, timeZone: 'Asia/Seoul' },
            h(OnboardingForm, { todayHref: '/today', chatsHref: '/chats', todayV3Enabled: true })));
        };`,
      resolveDir: WEB, loader: 'tsx',
    },
    bundle: true, format: 'iife', platform: 'browser', write: false, logLevel: 'silent', jsx: 'automatic',
    tsconfig: path.join(WEB, 'tsconfig.json'),
    define: { 'process.env.NODE_ENV': '"production"', 'process.env.NEXT_PUBLIC_APP_URL': '"https://dev-app.sprintable.ai"' },
    plugins: [onboardingStubPlugin(), layoutStubPlugin()],
  });
  const js = out.outputFiles[0]!.text;
  const candidates = tailwindCandidates(js);
  const compiler = await compile(readFileSync(path.join(APP, 'globals.css'), 'utf8'), { base: APP, onDependency: () => {} });
  const css = (optimize as unknown as (c: string, o?: object) => { code: string })(compiler.build(candidates), { minify: false }).code;
  built = { js, css };
  return built;
}

/** an answer; `__delay` holds it (ms) — the «loading» state is the page waiting on it */
type Answer = unknown | { __status: number; body: unknown; headers?: Record<string, string>; __delay?: number };
const MANIFEST = {
  product: 'Sprintable Dev Setup', version: '0.4.0', build: 'abc1234', notarized: false,
  url: 'https://storage.googleapis.com/sprintable-desktop-releases-dev/Sprintable-Dev-Setup.dmg',
};
const me = (displayName: string) => ({ data: { member_id: 'u-1', email_verified: true, email_verification_required: true, org_id: null, org_member_id: null, display_name: displayName } });
const ok = (body: unknown, extra: { __delay?: number } = {}) => ({ __status: 200, body, ...extra });
const fail = (status = 500, extra: { __delay?: number } = {}) => ({ __status: status, body: {}, ...extra });
const KEY = ['sk', 'live', 'abcdefghijklmnopqrstuvwxyz0123456789ABCD'].join('_');
const API: Record<string, Answer> = {
  'GET /api/auth/me': me('송윤재'),
  'GET /api/invites/mine': { invites: [] },
  'POST /api/organizations': { data: { id: 'org-1' } },
  'POST /api/auth/refresh': {},
  'GET /api/projects': { data: [{ id: 'proj-1' }] }, // the organization has a project → step ②; step ① scenes override with an empty list
  'POST /api/projects': { data: { id: 'proj-1' } },
  'POST /api/current-project': {},
  'POST /api/team-members': { data: { id: 'agent-1', api_key: KEY } },
  'GET /api/team-members': { data: [{ id: 'agent-1', runtime_type: 'claude' }] },
  'GET /api/agents/agent-1/connection-artifact': { data: { files: [{ filename: '.mcp.json', content: JSON.stringify({ mcpServers: { 'sprintable-mcp': { type: 'http', url: 'https://dev-mcp.sprintable.ai/mcp', headers: {} } } }) }] } },
  'GET /api/agents/agent-1/verification-status': { data: { verified: false, rail: [{ state: 'config_copied', status: 'done' }, { state: 'waiting', status: 'active' }, { state: 'mcp_reachable', status: 'pending' }, { state: 'verified', status: 'pending' }] } },
  'GET /api/activation/checklist': { data: { steps: { signed_up: true, email_verified: true, org_created: true, agent_connected: false, first_roundtrip: false }, completed: 3, total: 5, all_complete: false, first_instruction_conversation_id: null } },
  'POST /api/conversations': { id: 'conv-1' },
  'POST /api/onboarding/events': {},
  'GET /desktop/downloads/macos.json': { __status: 200, body: MANIFEST, headers: { 'x-desktop-download-bucket': 'sprintable-desktop-releases-dev' } },
};
const CONNECTED = { data: { steps: { signed_up: true, email_verified: true, org_created: true, agent_connected: true, first_roundtrip: false }, completed: 4, total: 5, all_complete: false, first_instruction_conversation_id: null } };

async function open(page: Page, o: { width: number; locale?: 'ko' | 'en'; mac?: boolean; inApp?: boolean; api?: Record<string, Answer> }) {
  const { js, css } = await build();
  const api = { ...API, ...(o.api ?? {}) };
  await page.setViewportSize({ width: o.width, height: o.width < 500 ? 844 : 1000 });
  await page.unrouteAll();
  await page.route('http://preview.test/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/') {
      return route.fulfill({ contentType: 'text/html', body: `<!doctype html><html lang="${o.locale ?? 'ko'}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head><body class="bg-background text-foreground"><div id="root"></div></body></html>` });
    }
    const a = api[`${route.request().method()} ${url.pathname}`] ?? api[url.pathname];
    if (a === undefined) return route.fulfill({ status: 404, body: '{}' });
    const { __status, body, headers, __delay } = (a && typeof a === 'object' && '__status' in a ? a : { __status: 200, body: a }) as { __status: number; body: unknown; headers?: Record<string, string>; __delay?: number };
    if (__delay) await new Promise((r) => setTimeout(r, __delay));
    return route.fulfill({ status: __status, contentType: 'application/json', body: JSON.stringify(body), ...(headers ? { headers } : {}) });
  });
  await page.goto('about:blank');
  await page.goto('http://preview.test/');
  if (o.mac !== false) {
    await page.evaluate(() => { Object.defineProperty(navigator, 'userAgent', { value: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36', configurable: true }); });
  }
  if (o.inApp) {
    // the Mac app's bridge (the shape the page reads — lib/desktop-app.ts `desktopAppOf`): the page runs inside the app
    await page.evaluate(() => { (window as unknown as { sprintableDesktop: unknown }).sprintableDesktop = { inApp: true, device: { name: 'Mac' }, runtimes: [], pickFolder: async () => null, startHere: async () => ({ ok: true }), setProjectFolder: async () => ({ ok: true }) }; });
  }
  const thrown: string[] = [];
  page.on('pageerror', (e) => thrown.push(e.message));
  await page.addScriptTag({ content: js });
  if (!(await page.evaluate(() => typeof (window as unknown as { __mount?: unknown }).__mount === 'function'))) {
    throw new Error(`the bundle did not start: ${thrown.join(' | ') || 'no page error'}`);
  }
  await page.evaluate((l) => (window as unknown as { __mount: (l: string) => void }).__mount(l), o.locale ?? 'ko');
}

const frames = (page: Page) => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(1)))));
const outDir = () => { const d = process.env['CAPTURE_OUT'] || test.info().outputDir; mkdirSync(d, { recursive: true }); return d; };
async function shot(page: Page, target: Locator, name: string) {
  await target.scrollIntoViewIfNeeded();
  await page.mouse.move(0, 0);
  await frames(page);
  await target.screenshot({ path: path.join(outDir(), `${name}.png`) });
}
const card = (page: Page) => page.getByTestId('onboarding-card');
const stepStates = (page: Page) => page.locator('[data-slot="ds-stepper-step"]').evaluateAll((els) => els.map((e) => e.getAttribute('data-state')));

/** nothing wider than the viewport — and, at a phone, every press ≥ 44, no text under 12 px, no old part (the 4891 measure) */
const measure = (page: Page) => page.evaluate(() => {
  const shown = (e: Element) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== 'hidden' && !e.closest('[aria-hidden="true"]') && (e as HTMLElement & { checkVisibility?: () => boolean }).checkVisibility?.() !== false; };
  const presses = [...document.querySelectorAll('button, a[href], input, select, summary, textarea')].filter(shown);
  const small = presses.filter((e) => { const r = e.getBoundingClientRect(); return r.width < 43.5 || r.height < 43.5; }).map((e) => `${(e.getAttribute('data-testid') || e.getAttribute('aria-label') || e.textContent || e.tagName).trim().slice(0, 24)} ${Math.round(e.getBoundingClientRect().width)}x${Math.round(e.getBoundingClientRect().height)}`);
  const leaves = [...document.querySelectorAll('body *')].filter((e) => e.children.length === 0 && (e.textContent || '').trim() && shown(e) && !e.closest('[data-slot="ds-chip"]'));
  const tiny = leaves.filter((e) => parseFloat(getComputedStyle(e).fontSize) < 12).map((e) => `${(e.textContent || '').trim().slice(0, 20)} ${getComputedStyle(e).fontSize}`);
  const oldSlots = [...document.querySelectorAll('[data-slot]')].map((e) => e.getAttribute('data-slot')!).filter((s) => !s.startsWith('ds-') && s !== 'textarea');
  return { small, tiny, oldSlots, overflowX: document.documentElement.scrollWidth > innerWidth + 1 };
});
async function clean(page: Page, label: string, phone: boolean) {
  const m = await measure(page);
  expect(m.overflowX, `${label}: overflow`).toBe(false);
  expect(m.oldSlots, `${label}: old (non-ds) parts drawn`).toEqual([]);
  if (phone) {
    expect(m.small, `${label}: presses under 44 px: ${m.small.join(' · ')}`).toEqual([]);
    expect(m.tiny, `${label}: text under 12 px: ${m.tiny.join(' · ')}`).toEqual([]);
  }
}

/** a short step keeps its card at the TOP of a phone (no floating in the middle of a tall empty screen) and stays centred from the desktop width (Two-Pass 11-26) */
async function cardPlace(page: Page, phone: boolean, label: string) {
  const box = (await card(page).boundingBox())!;
  if (phone) expect(box.y, `${label}: the card floats ${Math.round(box.y)} px below the top of a phone`).toBeLessThanOrEqual(40);
  else expect(box.y, `${label}: the card is not centred on the desktop (top ${Math.round(box.y)} px)`).toBeGreaterThan(100);
}

const LONG_NAME = 'Maximilian-Alexander-von-Hohenzollern'; // 37 letters, no space to break at (+ «의 조직» / «\'s organization»)
const LONG_PROJECT = '가나다라마바사아자차카타파하'.repeat(9); // 126 syllables, no space

for (const width of [1440, 390]) {
  const phone = width < 500;
  const tag = `L-${width}`;
  test.describe(`the straight line in six states · ${width}`, () => {
    if (phone) test.use({ hasTouch: true, isMobile: true });

    // ── ① the first project ─────────────────────────────────────────────────────────────
    test(`① project · default · ${tag}`, async ({ page }) => {
      await open(page, { width, api: { 'GET /api/projects': { data: [] } } });
      await expect(page.locator('h1')).toHaveText('첫 프로젝트 만들기');
      expect(await stepStates(page)).toEqual(['current', 'upcoming', 'upcoming']);
      await expect(page.getByTestId('onboarding-project-name')).toHaveValue('내 프로젝트');
      await clean(page, 'project default', phone);
      await cardPlace(page, phone, 'project default');
      await shot(page, card(page), `5036-1-project-default-${tag}`);
    });

    test(`① project · loading · ${tag}`, async ({ page }) => {
      await open(page, { width, api: { 'GET /api/projects': { data: [] }, 'POST /api/projects': ok({ data: { id: 'proj-1' } }, { __delay: 8000 }) } });
      await page.getByTestId('onboarding-project-create').click();
      await expect(page.getByTestId('onboarding-project-create')).toHaveAttribute('aria-busy', 'true'); // the press is held, the word says it is making
      await expect(page.getByTestId('onboarding-project-name')).toBeDisabled();
      await clean(page, 'project loading', phone);
      await shot(page, card(page), `5036-1-project-loading-${tag}`);
    });

    test(`① project · empty (the name cleared) · ${tag}`, async ({ page }) => {
      await open(page, { width, api: { 'GET /api/projects': { data: [] } } });
      await page.getByTestId('onboarding-project-name').fill('');
      await expect(page.getByTestId('onboarding-project-create')).toBeDisabled();
      await expect(page.getByTestId('onboarding-project-name')).toHaveAttribute('placeholder', '예: 첫 제품 출시');
      await clean(page, 'project empty', phone);
      await shot(page, card(page), `5036-1-project-empty-${tag}`);
    });

    test(`① project · error (the press failed → retry) · ${tag}`, async ({ page }) => {
      await open(page, { width, api: { 'GET /api/projects': { data: [] }, 'POST /api/projects': fail() } });
      await page.getByTestId('onboarding-project-create').click();
      await expect(page.getByTestId('onboarding-project-step').locator('[role="alert"]')).toHaveText(/프로젝트 생성에 실패했어요/);
      await expect(page.getByTestId('onboarding-project-create')).toBeEnabled(); // the press is open again
      await clean(page, 'project error', phone);
      await shot(page, card(page), `5036-1-project-error-${tag}`);
    });

    test(`① project · error (the list could not be read → «다시 확인») · ${tag}`, async ({ page }) => {
      await open(page, { width, api: { 'GET /api/projects': fail() } });
      await expect(page.getByTestId('onboarding-project-check-failed')).toBeVisible();
      await expect(page.getByTestId('onboarding-project-check-again')).toBeVisible();
      await expect(page.getByTestId('onboarding-project-step')).toHaveCount(0); // nothing is asked while it is not known whether there is one
      await clean(page, 'project check failed', phone);
      await shot(page, card(page), `5036-1-project-check-failed-${tag}`);
    });

    test(`① project · long text · ${tag}`, async ({ page }) => {
      await open(page, { width, api: { 'GET /api/projects': { data: [] }, 'GET /api/auth/me': me(LONG_NAME) } });
      await page.getByTestId('onboarding-project-name').fill(LONG_PROJECT);
      await expect(page.locator('h1')).toHaveText('첫 프로젝트 만들기');
      await clean(page, 'project long', phone);
      await shot(page, card(page), `5036-1-project-long-${tag}`);
    });

    // ── ② connect an agent ──────────────────────────────────────────────────────────────
    test(`② connect · default · ${tag}`, async ({ page }) => {
      await open(page, { width });
      await expect(page.locator('h1')).toHaveText('에이전트를 연결해요');
      expect(await stepStates(page)).toEqual(['done', 'current', 'upcoming']);
      await expect(page.getByTestId('connect-branch-new')).toBeVisible();
      await expect(page.getByTestId('connect-branch-move')).toBeVisible();
      await expect(page.getByTestId('connect-branch-key')).toBeVisible();
      await clean(page, 'connect default', phone);
      // the prerequisite note of the key way is read at the kit's smallest-text floor: no text of it under 12 px (rebaselined 11-27, 선생님 «독거노인용 같다» type-scale cut: the floor moved 14 → 12 — the note is the 13 px aux size now)
      const noteSizes = await page.getByTestId('advanced-prereq').locator('p').evaluateAll((els) => els.map((e) => parseFloat(getComputedStyle(e).fontSize)));
      expect(Math.min(...noteSizes), `the prerequisite note is drawn under 12 px: ${noteSizes.join(' · ')}`).toBeGreaterThanOrEqual(12);
      await expect(page.getByTestId('connect-branches-connected')).toHaveCount(0); // no agent is verified → no line (nothing is asserted that is not known)
      await shot(page, card(page), `5036-2-connect-default-${tag}`);
    });

    test(`② connect · an agent connected before the page was opened (the line over the three ways) · ${tag}`, async ({ page }) => {
      const verified = { data: { verified: true, rail: [{ state: 'config_copied', status: 'done' }, { state: 'waiting', status: 'done' }, { state: 'mcp_reachable', status: 'done' }, { state: 'verified', status: 'done' }] } };
      await open(page, { width, api: { 'GET /api/team-members': { data: [{ id: 'agent-7', name: LONG_NAME }] }, 'GET /api/agents/agent-7/verification-status': verified } });
      await expect(page.getByTestId('connect-branches-connected')).toBeVisible();
      await expect(page.getByTestId('connect-branches-connected-name')).toHaveText(LONG_NAME);
      // the line stands OVER the three ways, which are all still there
      const line = (await page.getByTestId('connect-branches-connected').boundingBox())!;
      const first = (await page.getByTestId('connect-branch-new').boundingBox())!;
      expect(line.y + line.height, 'the line is above the first way').toBeLessThanOrEqual(first.y + 1);
      for (const id of ['connect-branch-new', 'connect-branch-move', 'connect-branch-key']) await expect(page.getByTestId(id)).toBeVisible();
      expect(await stepStates(page)).toEqual(['done', 'current', 'upcoming']); // still step ②: the line is a way on, not a jump
      await clean(page, 'connect connected-before', phone);
      await shot(page, card(page), `5036-2-connect-connected-before-${tag}`);
    });

    test(`② connect · loading (the key way is making the agent) · ${tag}`, async ({ page }) => {
      await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: 'http://preview.test' });
      await open(page, { width, api: { 'POST /api/team-members': ok({ data: { id: 'agent-1', api_key: KEY } }, { __delay: 8000 }) } });
      await page.getByTestId('advanced-make').click();
      await expect(page.getByTestId('advanced-make')).toBeDisabled();
      await expect(page.getByTestId('advanced-make')).toContainText('만드는 중');
      await expect(page.getByTestId('onboarding-first-finish')).toBeDisabled(); // the other way out waits: an agent and a key could be made with nothing left to revoke them
      await clean(page, 'connect loading', phone);
      await shot(page, card(page), `5036-2-connect-loading-${tag}`);
    });

    test(`② connect · empty (not a Mac: the two app ways say why) · ${tag}`, async ({ page }) => {
      await open(page, { width, mac: false });
      await expect(page.getByTestId('connect-branch-new-reason')).toBeVisible();
      await expect(page.getByTestId('connect-branch-move-reason')).toBeVisible();
      await expect(page.getByTestId('advanced-make')).toBeVisible();
      await expect(page.getByTestId('desktop-download-card')).toHaveCount(0);
      await clean(page, 'connect not a Mac', phone);
      await shot(page, card(page), `5036-2-connect-empty-${tag}`);
    });

    test(`② connect · error (the agent could not be made → the press is open again) · ${tag}`, async ({ page }) => {
      await open(page, { width, api: { 'POST /api/team-members': fail() } });
      await page.getByTestId('advanced-make').click();
      await expect(page.getByTestId('advanced-failed')).toBeVisible();
      await expect(page.getByTestId('advanced-make')).toBeEnabled();
      await clean(page, 'connect error', phone);
      await shot(page, card(page), `5036-2-connect-error-${tag}`);
    });

    test(`② connect · long text (a long organization name · en) · ${tag}`, async ({ page }) => {
      await open(page, { width, locale: 'en', api: { 'GET /api/auth/me': me(LONG_NAME) } });
      await expect(page.locator('h1')).toHaveText('Connect an agent');
      await expect(page.getByTestId('onboarding-first-org')).toBeVisible();
      await clean(page, 'connect long en', phone);
      await shot(page, card(page), `5036-2-connect-long-en-${tag}`);
    });

    // ── the Mac app (story 5036 · PO 11-26): a NEW account takes the same line — ① the project, ② the three ways in their in-app shape ─────────────────────
    test(`① project · in the Mac app (a new account) · ${tag}`, async ({ page }) => {
      await open(page, { width, inApp: true, api: { 'GET /api/projects': { data: [] } } });
      await expect(page.locator('h1')).toHaveText('첫 프로젝트 만들기');
      expect(await stepStates(page)).toEqual(['current', 'upcoming', 'upcoming']);
      await clean(page, 'app project', phone);
      await cardPlace(page, phone, 'app project');
      await shot(page, card(page), `5036-1-project-app-${tag}`);
    });

    test(`② connect · in the Mac app (the two app ways are done here: no chip · no download · no phone card) · ${tag}`, async ({ page }) => {
      await open(page, { width, inApp: true, api: { 'GET /api/projects': { data: [] } } });
      await page.getByTestId('onboarding-project-create').click();
      await expect(page.locator('h1')).toHaveText('에이전트를 연결해요');
      expect(await stepStates(page)).toEqual(['done', 'current', 'upcoming']);
      for (const id of ['connect-branch-new', 'connect-branch-move', 'connect-branch-key']) await expect(page.getByTestId(id)).toBeVisible();
      await expect(page.getByTestId('connect-branch-new-open')).toHaveText('새로 만들기 시작');
      await expect(page.getByTestId('connect-branch-move-open')).toHaveText('옮기기 시작');
      await expect(page.getByTestId('connect-branches-download')).toHaveCount(0);
      await expect(page.getByText('데스크톱 앱에서 해요')).toHaveCount(0);
      await clean(page, 'app connect', phone);
      await shot(page, card(page), `5036-2-connect-app-${tag}`);
    });

    // ── ③ the first conversation ────────────────────────────────────────────────────────
    test(`③ chat · default · ${tag}`, async ({ page }) => {
      await open(page, { width, api: { 'GET /api/activation/checklist': CONNECTED } });
      await expect(page.locator('h1')).toHaveText('연결됐어요');
      expect(await stepStates(page)).toEqual(['done', 'done', 'current']);
      await expect(page.getByTestId('onboarding-first-chat-start')).toHaveText('첫 지시 보내기');
      await clean(page, 'chat default', phone);
      await cardPlace(page, phone, 'chat default');
      await shot(page, card(page), `5036-3-chat-default-${tag}`);
    });

    test(`③ chat · loading (the conversation is being opened) · ${tag}`, async ({ page }) => {
      await open(page, { width, api: { 'GET /api/activation/checklist': CONNECTED, 'POST /api/conversations': ok({ id: 'conv-1' }, { __delay: 8000 }) } });
      await page.getByTestId('onboarding-first-chat-start').click();
      await expect(page.getByTestId('onboarding-first-chat-start')).toHaveAttribute('aria-busy', 'true');
      await expect(page.getByTestId('onboarding-first-chat-finish')).toBeDisabled();
      await clean(page, 'chat loading', phone);
      await shot(page, card(page), `5036-3-chat-loading-${tag}`);
    });

    test(`③ chat · long text (en) · ${tag}`, async ({ page }) => {
      await open(page, { width, locale: 'en', api: { 'GET /api/activation/checklist': CONNECTED } });
      await expect(page.locator('h1')).toHaveText("It's connected");
      await clean(page, 'chat long en', phone);
      await shot(page, card(page), `5036-3-chat-long-en-${tag}`);
    });
  });
}
