/**
 * story 4668 — Yuna's capture list (chat f7633ed9 07:16Z): the fork (default · changed) · «데스크톱 앱 받기» («더 보기» folded / open) ·
 * the connect step after [건너뛰기] · 390 wrapping. The real OnboardingForm (bundled here with esbuild — not copied) and the real
 * Tailwind build of globals.css, in Chromium. No server of ours: the page and its API answers are made here (the shared stub list
 * `support/layout-stubs.ts` + two modules this form takes more names from, overridden in this file only). Harness = PR 4972's
 * (`allowed-hosts.4580.layout.spec.ts`) via `remote-off.4583.layout.spec.ts`.
 *
 * Each scene is also an assertion: the h1 and the step label (bar only before the fork · «3 / 3» · «5 / 5») · the one primary control
 * on the download screen is the card's [다운로드] · «더 보기» folded hides the remote-control block and the way back · at 390 nothing
 * is wider than the viewport (no horizontal scroll) and the Korean lines wrap by words (break-keep). Names
 * `4668-{scene}-{L|D}-{width}.png`. Files go to CAPTURE_OUT when set, else this test's output folder.
 */
import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { expect, test, type Locator, type Page } from '@playwright/test';
import type { Plugin } from 'esbuild';
import { compile, optimize } from '@tailwindcss/node';
import { layoutStubPlugin } from './support/layout-stubs';

const req = createRequire(__filename);
const WEB = path.join(__dirname, '..');
const APP = path.join(WEB, 'src', 'app');

/** the two shared stubs the onboarding form takes more names from (withProjectParam · refreshAuthTokens) — overridden here, first */
function onboardingStubPlugin(): Plugin {
  const bodies: Record<string, string> = {
    '@/hooks/use-flat-href': 'export function useFlatHref() { return (h) => h; } export function withProjectParam(h) { return h; }',
    '@/lib/db/client': 'export const fetchWithAuth = (u, i) => fetch(u, i); export const refreshAuthTokens = async () => null; export const logoutUser = async () => {};',
  };
  const filter = new RegExp(`^(${Object.keys(bodies).map((k) => k.replace(/[/.-]/g, '\\$&')).join('|')})$`);
  return {
    name: 'onboarding-4668-stubs',
    setup(b) {
      b.onResolve({ filter }, (a) => ({ path: a.path, namespace: 'stub4668' }));
      b.onLoad({ filter: /.*/, namespace: 'stub4668' }, (a) => ({ contents: bodies[a.path]!, loader: 'js', resolveDir: WEB }));
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
    define: { 'process.env.NODE_ENV': '"production"', 'process.env.NEXT_PUBLIC_APP_URL': '"https://app.sprintable.ai"' },
    plugins: [onboardingStubPlugin(), layoutStubPlugin()],
  });
  const js = out.outputFiles[0]!.text;
  const candidates = [...new Set([...js.matchAll(/"([^"\n]+)"/g)].flatMap((m) => m[1]!.split(/\s+/)).filter(Boolean))];
  const compiler = await compile(readFileSync(path.join(APP, 'globals.css'), 'utf8'), { base: APP, onDependency: () => {} });
  const css = (optimize as unknown as (c: string, o?: object) => { code: string })(compiler.build(candidates), { minify: false }).code;
  built = { js, css };
  return built;
}

type Answer = unknown | { __status: number; body: unknown; headers?: Record<string, string> };
const MANIFEST = {
  product: 'Sprintable Dev Setup', version: '0.4.0', build: 'abc1234', notarized: false,
  url: 'https://storage.googleapis.com/sprintable-desktop-releases-dev/Sprintable-Dev-Setup.dmg',
};
const API: Record<string, Answer> = {
  'GET /api/auth/me': { data: { member_id: 'u-1', email_verified: true, email_verification_required: true } },
  'POST /api/organizations': { data: { id: 'org-1' } },
  'POST /api/auth/refresh': {},
  'POST /api/projects': { data: { id: 'proj-1' } },
  'POST /api/current-project': {},
  'POST /api/onboarding/events': {},
  // story 4697: the manifest route tells the card its bucket in a header — without it the card closes («지금은 받을 수 없어요»)
  'GET /desktop/downloads/macos.json': { __status: 200, body: MANIFEST, headers: { 'x-desktop-download-bucket': 'sprintable-desktop-releases-dev' } },
  // the organization's owner, remote control off → the 4656 block is drawn under «더 보기» when opened
  'GET /api/organizations/org-1/remote-control': { data: { enabled: false, enabled_at: null, can_change: true, owner_names: ['송윤재'], connected_setups: 0 } },
};

async function open(page: Page, o: { width: number; theme: 'L' | 'D'; locale?: 'ko' | 'en' }) {
  const { js, css } = await build();
  await page.setViewportSize({ width: o.width, height: o.width < 500 ? 844 : 1000 });
  await page.unrouteAll();
  await page.route('http://preview.test/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/') {
      return route.fulfill({ contentType: 'text/html', body: `<!doctype html><html lang="${o.locale ?? 'ko'}" class="${o.theme === 'D' ? 'dark' : ''}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head><body class="bg-background text-foreground"><div id="root"></div></body></html>` });
    }
    const a = API[`${route.request().method()} ${url.pathname}`] ?? API[url.pathname];
    if (a === undefined) return route.fulfill({ status: 404, body: '{}' });
    const { __status, body, headers } = (a && typeof a === 'object' && '__status' in a ? a : { __status: 200, body: a }) as { __status: number; body: unknown; headers?: Record<string, string> };
    return route.fulfill({ status: __status, contentType: 'application/json', body: JSON.stringify(body), ...(headers ? { headers } : {}) });
  });
  await page.goto('about:blank');
  await page.goto('http://preview.test/');
  // a Mac's user agent — the download card draws [다운로드] for a Mac only (the harness's Chromium reports Linux)
  await page.evaluate(() => { Object.defineProperty(navigator, 'userAgent', { value: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36', configurable: true }); });
  const thrown: string[] = [];
  page.on('pageerror', (e) => thrown.push(e.message));
  await page.addScriptTag({ content: js });
  if (!(await page.evaluate(() => typeof (window as unknown as { __mount?: unknown }).__mount === 'function'))) {
    throw new Error(`the bundle did not start — likely a module to stub (STUBS): ${thrown.join(' | ') || 'no page error'}`);
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

/** nothing wider than the viewport (no horizontal scroll) — Yuna: 390 wrapping is checked on the capture */
async function fitsViewport(page: Page, width: number) {
  const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(scrollWidth, 'no horizontal overflow').toBeLessThanOrEqual(width);
}

// ── the way to each scene ───────────────────────────────────────────────────────────────────────────────────────────────────
const card = (page: Page) => page.getByTestId('onboarding-card');
const stepOf = (page: Page) => page.getByTestId('onboarding-step-of');

async function makeOrg(page: Page) {
  const input = page.locator('input').first();
  await expect(input).toBeEnabled(); // the draft gate opens once /api/auth/me answered
  await input.fill('문클랩스'); // story 4669: the name alone — the slug field is gone (the server derives it)
  await page.getByRole('button', { name: '조직 만들기' }).click();
  await expect(page.locator('h1')).toHaveText('에이전트를 어디서 돌릴까요?');
}

async function toDownload(page: Page) {
  await makeOrg(page);
  await page.getByTestId('onboarding-where-continue').click();
  await expect(page.locator('h1')).toHaveText('데스크톱 앱 받기');
  await expect(page.getByTestId('desktop-download-button')).toBeVisible();
}

async function toSkippedConnect(page: Page) {
  await makeOrg(page);
  await page.locator('[data-testid=onboarding-where-web] input').check();
  await page.getByTestId('onboarding-where-continue').click();
  await expect(page.locator('h1')).toHaveText('첫 프로젝트 만들기');
  await page.locator('input').first().fill('첫 프로젝트');
  await page.getByRole('button', { name: '프로젝트 만들기' }).click();
  await expect(page.locator('h1')).toHaveText('AI 에이전트 추가');
  await page.getByRole('button', { name: '건너뛰기' }).click();
  await expect(page.locator('h1')).toHaveText('에이전트 연결');
  await expect(page.getByTestId('desktop-download-button')).toBeVisible();
}

for (const width of [1440, 390]) {
  for (const theme of ['L', 'D'] as const) {
    const tag = `${theme}-${width}`;

    test(`fork · default (app) and changed (web) · ${tag}`, async ({ page }) => {
      await open(page, { width, theme });
      await makeOrg(page);
      await expect(stepOf(page)).toHaveCount(0); // bar only before the fork is chosen
      await expect(page.locator('[data-testid=onboarding-where-app] input')).toBeChecked();
      await expect(page.getByTestId('onboarding-where-not-mac')).toHaveCount(0);
      await fitsViewport(page, width);
      await shot(page, card(page), `4668-1-fork-default-${tag}`);
      await page.locator('[data-testid=onboarding-where-web] input').check();
      await expect(page.getByTestId('onboarding-progress-bar')).toHaveCSS('width', /.+/);
      await shot(page, card(page), `4668-1-fork-web-${tag}`);
    });

    test(`download · «더 보기» folded and open · ${tag}`, async ({ page }) => {
      await open(page, { width, theme });
      await toDownload(page);
      await expect(stepOf(page)).toHaveText('3 / 3');
      // the one primary control is the card's [다운로드]
      const primaries = page.locator('a[class*="bg-primary"], button[class*="bg-primary"]');
      await expect(primaries).toHaveCount(1);
      await expect(primaries.first()).toHaveAttribute('data-testid', 'desktop-download-button');
      await expect(page.getByTestId('onboarding-download-more')).toHaveAttribute('aria-expanded', 'false');
      await expect(page.getByTestId('onboarding-remote-control')).toHaveCount(0);
      await expect(page.getByTestId('onboarding-download-back-to-choice')).toHaveCount(0);
      await fitsViewport(page, width);
      await shot(page, card(page), `4668-2-download-folded-${tag}`);
      await page.getByTestId('onboarding-download-more').click();
      await expect(page.getByTestId('onboarding-download-more')).toHaveAttribute('aria-expanded', 'true');
      await expect(page.getByTestId('onboarding-remote-control')).toBeVisible();
      await expect(page.getByTestId('onboarding-download-back-to-choice')).toBeVisible();
      await fitsViewport(page, width);
      await shot(page, card(page), `4668-2-download-open-${tag}`);
    });

    test(`connect after [건너뛰기] · ${tag}`, async ({ page }) => {
      await open(page, { width, theme });
      await toSkippedConnect(page);
      await expect(stepOf(page)).toHaveText('5 / 5');
      await expect(page.getByTestId('connect-step-no-agent')).toBeVisible();
      await expect(page.getByTestId('connect-step-make-agent')).toBeVisible();
      await expect(page.getByText('API Key 발급에 실패했어요', { exact: false })).toHaveCount(0);
      await expect(page.getByRole('button', { name: '첫 지시 보내기' })).toHaveCount(0);
      await fitsViewport(page, width);
      await shot(page, card(page), `4668-3-connect-skipped-${tag}`);
    });
  }
}
