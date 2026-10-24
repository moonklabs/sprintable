/**
 * story 4668 → 4715 — the onboarding's screens at 1440 and 390, light and dark. Story 4715 replaced the organization-name step, the fork
 * and «데스크톱 앱 받기» with one first screen (plan yuna/4715-plan-1016.md): on a Mac «에이전트는 내 Mac에서 돌아가요» + [Mac 앱 받기];
 * elsewhere «지금은 Mac 앱만 있어요» + the web way; pending invites first (the invited card). Story 4766: the web way is ONE press (the project,
 * the agent and its key made together, the one line to paste) — folded under «고급» on a Mac, standing on the screen elsewhere. The real OnboardingForm (bundled here with esbuild — not copied) and the real Tailwind build of globals.css, in
 * Chromium. No server of ours: the page and its API answers are made here (the shared stub list `support/layout-stubs.ts` + two modules
 * this form takes more names from, overridden in this file only). Harness = PR 4972's (`allowed-hosts.4580.layout.spec.ts`) via
 * `remote-off.4583.layout.spec.ts`.
 *
 * Each scene is also an assertion: the h1 · the step label (none on the first screen · «3 / 3» on connect) · the one primary control on
 * the Mac screen is the card's [Mac 앱 받기] · at 390 nothing is wider than the viewport (no horizontal scroll) and the Korean lines wrap
 * by words (break-keep). Names `4715-{scene}-{L|D}-{width}.png`. Files go to CAPTURE_OUT when set, else this test's output folder.
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
const INVITE = { invite_id: 'inv-1', org_id: 'org-x', org_name: '문클랩스', role: 'member', expires_at: '2026-10-30T00:00:00Z' };
const API: Record<string, Answer> = {
  'GET /api/auth/me': { data: { member_id: 'u-1', email_verified: true, email_verification_required: true, org_id: null, org_member_id: null, display_name: '송윤재' } },
  // story 4715: arrival reads the pending invites before it makes the organization (none here; the invited scene overrides it)
  'GET /api/invites/mine': { invites: [] }, // the backend's one shape (MyInvitesResponse · no envelope)
  'POST /api/organizations': { data: { id: 'org-1' } },
  'POST /api/auth/refresh': {},
  'GET /api/projects': { data: [] },
  'POST /api/projects': { data: { id: 'proj-1' } },
  'POST /api/current-project': {},
  // story 4766: the folded web way's one press — the agent and its key, the hosted address, the panel's first answer
  'POST /api/team-members': { data: { id: 'agent-1', api_key: ['sk', 'live', 'abcdefghijklmnopqrstuvwxyz0123456789ABCD'].join('_') // built, not written: a literal `sk_live_…` reads as a Stripe key to push protection } },
  'GET /api/agents/agent-1/connection-artifact': { data: { files: [{ filename: '.mcp.json', content: JSON.stringify({ mcpServers: { 'sprintable-mcp': { type: 'http', url: 'https://dev-mcp.sprintable.ai/mcp', headers: {} } } }) }] } },
  'GET /api/agents/agent-1/verification-status': { data: { verified: false, rail: [{ state: 'config_copied', status: 'done' }, { state: 'waiting', status: 'active' }, { state: 'mcp_reachable', status: 'pending' }, { state: 'verified', status: 'pending' }] } },
  'POST /api/onboarding/events': {},
  // story 4697: the manifest route tells the card its bucket in a header — without it the card closes («지금은 받을 수 없어요»)
  'GET /desktop/downloads/macos.json': { __status: 200, body: MANIFEST, headers: { 'x-desktop-download-bucket': 'sprintable-desktop-releases-dev' } },
  // the organization's owner, remote control off → the 4656 block is drawn under «더 보기» when opened
  'GET /api/organizations/org-1/remote-control': { data: { enabled: false, enabled_at: null, can_change: true, owner_names: ['송윤재'], connected_setups: 0 } },
};

async function open(page: Page, o: { width: number; theme: 'L' | 'D'; locale?: 'ko' | 'en'; mac?: boolean; api?: Record<string, Answer> }) {
  const { js, css } = await build();
  const api = { ...API, ...(o.api ?? {}) };
  await page.setViewportSize({ width: o.width, height: o.width < 500 ? 844 : 1000 });
  await page.unrouteAll();
  await page.route('http://preview.test/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/') {
      return route.fulfill({ contentType: 'text/html', body: `<!doctype html><html lang="${o.locale ?? 'ko'}" class="${o.theme === 'D' ? 'dark' : ''}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head><body class="bg-background text-foreground"><div id="root"></div></body></html>` });
    }
    const a = api[`${route.request().method()} ${url.pathname}`] ?? api[url.pathname];
    if (a === undefined) return route.fulfill({ status: 404, body: '{}' });
    const { __status, body, headers } = (a && typeof a === 'object' && '__status' in a ? a : { __status: 200, body: a }) as { __status: number; body: unknown; headers?: Record<string, string> };
    return route.fulfill({ status: __status, contentType: 'application/json', body: JSON.stringify(body), ...(headers ? { headers } : {}) });
  });
  await page.goto('about:blank');
  await page.goto('http://preview.test/');
  // a Mac's user agent unless the scene is the not-Mac face — the first screen and its download card follow the device (the harness's
  // Chromium reports Linux)
  if (o.mac !== false) {
    await page.evaluate(() => { Object.defineProperty(navigator, 'userAgent', { value: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36', configurable: true }); });
  }
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

/** story 4715: arrival makes the organization on its own (no name field) and lands on the one first screen */
async function toFirst(page: Page, mac = true) {
  await expect(page.locator('h1')).toHaveText(mac ? '에이전트는 내 Mac에서 돌아가요' : '지금은 Mac 앱만 있어요');
}

for (const width of [1440, 390]) {
  for (const theme of ['L', 'D'] as const) {
    const tag = `${theme}-${width}`;

    test(`first screen · a Mac · ${tag}`, async ({ page }) => {
      await open(page, { width, theme });
      await toFirst(page);
      await expect(stepOf(page)).toHaveCount(0); // no progress strip on the first screen
      // the one primary control is the card's [Mac 앱 받기]; the web way is a CLOSED fold (story 4766) and an installed app is opened, not downloaded
      const primaries = page.locator('a[class*="bg-primary"], button[class*="bg-primary"]');
      await expect(primaries).toHaveCount(1);
      await expect(primaries.first()).toHaveAttribute('data-testid', 'desktop-download-button');
      await expect(primaries.first()).toHaveText('Mac 앱 받기');
      await expect(page.getByTestId('onboarding-first-org')).toHaveText('송윤재의 조직에서 시작해요 · 이름은 설정에서 바꿀 수 있어요');
      await expect(page.locator('input[type="radio"]')).toHaveCount(0);
      await expect(page.getByTestId('onboarding-first-advanced')).toHaveJSProperty('open', false);
      await expect(page.getByTestId('onboarding-first-advanced-summary')).toHaveText('고급 — 앱 없이, 이미 쓰는 Claude Code · Codex 연결');
      await expect(page.getByTestId('onboarding-first-open-app')).toHaveText('앱 열기');
      await fitsViewport(page, width);
      await shot(page, card(page), `4715-1-first-mac-${tag}`);
    });

    test(`first screen · not a Mac · ${tag}`, async ({ page }) => {
      await open(page, { width, theme, mac: false });
      await toFirst(page, false);
      await expect(page.getByTestId('advanced-make')).toBeVisible(); // not a Mac: the web way is the only way, so it stands unfolded
      await expect(page.getByTestId('desktop-download-card')).toHaveCount(0);
      await fitsViewport(page, width);
      await shot(page, card(page), `4715-2-first-not-mac-${tag}`);
    });

    // story 4766 AC3: the fold is found and the one press stands on the FIRST screen — nothing to scroll to (1440 × 1000)
    test(`first screen · a Mac · the web way opened · ${tag}`, async ({ page }) => {
      await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: 'http://preview.test' });
      await open(page, { width, theme });
      await toFirst(page);
      const summary = page.getByTestId('onboarding-first-advanced-summary');
      await summary.click();
      await expect(page.getByTestId('onboarding-first-advanced')).toHaveJSProperty('open', true);
      await expect(page.getByTestId('advanced-prereq')).toBeVisible();
      await expect(page.getByTestId('advanced-install-claude')).toBeVisible();
      await expect(page.getByTestId('advanced-make')).toBeVisible();
      if (width >= 1000) {
        const viewportHeight = await page.evaluate(() => window.innerHeight);
        for (const id of ['onboarding-first-advanced-summary', 'advanced-make']) {
          const box = await page.getByTestId(id).boundingBox();
          expect(box!.y + box!.height, `${id} is inside the first screen (no scroll)`).toBeLessThanOrEqual(viewportHeight);
        }
      }
      await fitsViewport(page, width);
      await shot(page, card(page), `4766-1-first-mac-fold-open-${tag}`);
    });

    test(`the one press · the line, where the key stays, [키 폐기] · ${tag}`, async ({ page }) => {
      await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: 'http://preview.test' });
      await open(page, { width, theme });
      await toFirst(page);
      await page.getByTestId('onboarding-first-advanced-summary').click();
      await page.getByTestId('advanced-make').click();
      await expect(page.getByTestId('advanced-line')).toContainText('claude mcp add --transport http --scope local sprintable-mcp https://dev-mcp.sprintable.ai/mcp');
      await expect(page.getByTestId('advanced-line')).toContainText('sk_live_••••ABCD');
      await expect(page.getByTestId('advanced-key-line')).toContainText('셸 기록');
      await expect(page.getByTestId('advanced-revoke')).toBeVisible();
      await expect(page.getByTestId('advanced-verify')).toBeVisible();
      await fitsViewport(page, width);
      await shot(page, card(page), `4766-2-the-press-${tag}`);
    });

    test(`pending invite · the invited card, no organization made · ${tag}`, async ({ page }) => {
      const made: string[] = [];
      page.on('request', (r) => { if (r.method() === 'POST' && r.url().endsWith('/api/organizations')) made.push(r.url()); });
      await open(page, { width, theme, api: { 'GET /api/invites/mine': { invites: [INVITE] } } });
      await expect(page.getByTestId('setup-invited')).toContainText('초대받은 조직이 있어요');
      await expect(page.getByTestId('setup-invited-own-org')).toHaveText('내 조직을 새로 만들기');
      expect(made).toHaveLength(0);
      await fitsViewport(page, width);
      await shot(page, page.getByTestId('onboarding-invited'), `4715-3-invited-${tag}`);
    });
  }
}
