/**
 * story 4906 (the first-run lap, web en 1100 · ko 1440 · 390) — three things the lap found on the onboarding, measured on the REAL OnboardingForm (bundled with esbuild — not copied) and the real Tailwind build (harness = onboarding.4668.layout.spec.ts):
 *  ① the «Use it on your phone» row is a boxed row: all four sides drawn (it had no bottom line — the list-row's «no line under» class on a row that stands alone, next to the closed «고급» box that has all four);
 *  ② the install commands («You need this first») have a full-width line of their own and break only after a «/» or at a space — never inside a word (they broke as «http» / «s://claude.ai/ins» / «tall.sh» in a narrow shared column);
 *  ③ the screen of a person whose organization was deleted has two ways out besides «new organization»: sign out · delete the account (they used to have one press, and /settings sent them back here).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { expect, test, type Page } from '@playwright/test';
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
    '@/lib/db/client': 'export const fetchWithAuth = (u, i) => fetch(u, i); export const refreshAuthTokens = async () => ({ data: { ok: true }, error: null }); export const refreshSessionOnce = refreshAuthTokens; export const refreshSessionAfterChange = refreshAuthTokens; export const switchOrg = async () => new Response(JSON.stringify({ data: { ok: true } })); export const switchProject = switchOrg; export const logoutUser = async () => {};',
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
        window.__mount = (locale, props) => {
          const root = createRoot(document.getElementById('root'));
          root.render(h(NextIntlClientProvider, { locale, messages: locale === 'en' ? en : ko, timeZone: 'Asia/Seoul' },
            h(OnboardingForm, { todayHref: '/today', chatsHref: '/chats', todayV3Enabled: true, ...(props || {}) })));
        };`,
      resolveDir: WEB, loader: 'tsx',
    },
    bundle: true, format: 'iife', platform: 'browser', write: false, logLevel: 'silent', jsx: 'automatic',
    tsconfig: path.join(WEB, 'tsconfig.json'),
    define: { 'process.env.NODE_ENV': '"production"', 'process.env.NEXT_PUBLIC_APP_URL': '"https://dev-app.sprintable.ai"' /* the dev web publishes the phone app → the «phone» row is drawn (on the production web nothing is published and the row is not) */ },
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
  'GET /api/auth/me': { data: { member_id: 'u-1', email_verified: true, email_verification_required: true, org_id: null, org_member_id: null, display_name: '송윤재' } },
  // story 4715: arrival reads the pending invites before it makes the organization (none here; the invited scene overrides it)
  'GET /api/invites/mine': { invites: [] }, // the backend's one shape (MyInvitesResponse · no envelope)
  'POST /api/organizations': { data: { id: 'org-1' } },
  'POST /api/auth/refresh': {},
  'GET /api/projects': { data: [] },
  'POST /api/projects': { data: { id: 'proj-1' } },
  'POST /api/current-project': {},
  // story 4766: the folded web way's one press — the agent and its key, the hosted address, the panel's first answer
  // (the key's prefix is built, not written: a literal `sk_live_…` reads as a Stripe key to the push-protection scanner)
  'POST /api/team-members': { data: { id: 'agent-1', api_key: ['sk', 'live', 'abcdefghijklmnopqrstuvwxyz0123456789ABCD'].join('_') } },
  'GET /api/agents/agent-1/connection-artifact': { data: { files: [{ filename: '.mcp.json', content: JSON.stringify({ mcpServers: { 'sprintable-mcp': { type: 'http', url: 'https://dev-mcp.sprintable.ai/mcp', headers: {} } } }) }] } },
  'GET /api/agents/agent-1/verification-status': { data: { verified: false, rail: [{ state: 'config_copied', status: 'done' }, { state: 'waiting', status: 'active' }, { state: 'mcp_reachable', status: 'pending' }, { state: 'verified', status: 'pending' }] } },
  'POST /api/onboarding/events': {},
  // story 4697: the manifest route tells the card its bucket in a header — without it the card closes («지금은 받을 수 없어요»)
  'GET /desktop/downloads/macos.json': { __status: 200, body: MANIFEST, headers: { 'x-desktop-download-bucket': 'sprintable-desktop-releases-dev' } },
  // the organization's owner, remote control off → the 4656 block is drawn under «더 보기» when opened
  'GET /api/organizations/org-1/remote-control': { data: { enabled: false, enabled_at: null, can_change: true, owner_names: ['송윤재'], connected_setups: 0 } },
};

async function open(page: Page, o: { width: number; theme: 'L' | 'D'; locale?: 'ko' | 'en'; mac?: boolean; api?: Record<string, Answer>; height?: number; props?: Record<string, unknown> }) {
  const { js, css } = await build();
  const api = { ...API, ...(o.api ?? {}) };
  await page.setViewportSize({ width: o.width, height: o.height ?? (o.width < 500 ? 844 : 1000) });
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
  await page.evaluate(([l, p]) => (window as unknown as { __mount: (l: string, p: unknown) => void }).__mount(l as string, p), [o.locale ?? 'ko', o.props ?? null]);
}

const frames = (page: Page) => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(1)))));

/** ① the four sides of the phone row's box are drawn, one width, one colour */
for (const locale of ['ko', 'en'] as const) {
  for (const width of [1100, 1440, 390]) {
    test(`[SID:4906] first screen · the «phone» row is a full box (four sides) · ${locale} · ${width}`, async ({ page }) => {
      await open(page, { width, theme: 'L', locale });
      const row = page.getByTestId('phone-app-row-toggle');
      await expect(row).toBeVisible();
      const sides = await row.evaluate((el) => { const s = getComputedStyle(el); return { t: s.borderTopWidth, r: s.borderRightWidth, b: s.borderBottomWidth, l: s.borderLeftWidth, tc: s.borderTopColor, bc: s.borderBottomColor }; });
      expect(sides.b, `bottom side drawn: ${JSON.stringify(sides)}`).toBe(sides.t);
      expect(sides.l).toBe(sides.t);
      expect(sides.r).toBe(sides.t);
      expect(sides.t).not.toBe('0px');
      expect(sides.bc, 'the bottom line has the colour of the top line').toBe(sides.tc);
    });
  }
}

/** ② the install lines break only after a «/» or at a space (the last line is free) */
for (const locale of ['ko', 'en'] as const) {
  for (const width of [1100, 390]) {
    test(`[SID:4906] «Advanced» · the install commands break after a slash or at a space, never inside a word · ${locale} · ${width}`, async ({ page }) => {
      await open(page, { width, theme: 'L', locale });
      await page.getByTestId('onboarding-first-advanced-summary').click();
      for (const rt of ['claude', 'codex']) {
        const line = page.getByTestId(`advanced-install-line-${rt}`);
        await expect(line).toBeVisible();
        const li = page.getByTestId(`advanced-install-${rt}`);
        const [lw, cw] = await Promise.all([li.evaluate((e) => e.getBoundingClientRect().width), line.evaluate((e) => e.getBoundingClientRect().width)]);
        expect(cw, `the command line is as wide as its row (${cw} of ${lw})`).toBeGreaterThanOrEqual(lw - 1);
        // the line holds its text: nothing sticks out of the box (a long address that cannot break would)
        expect(await line.evaluate((e) => e.scrollWidth <= e.clientWidth + 1), 'the command stays inside its box').toBe(true);
        const broken = await line.evaluate((el) => {
          const chars: { ch: string; top: number }[] = [];
          const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
          for (let n = walker.nextNode(); n; n = walker.nextNode()) {
            const t = n as Text;
            for (let i = 0; i < t.data.length; i++) { const r = document.createRange(); r.setStart(t, i); r.setEnd(t, i + 1); const b = r.getClientRects()[0]; if (b) chars.push({ ch: t.data[i]!, top: Math.round(b.top) }); }
          }
          const bad: string[] = [];
          for (let i = 0; i < chars.length - 1; i++) {
            if (chars[i + 1]!.top > chars[i]!.top + 2) { // a line ends here
              if (chars[i]!.ch !== '/' && chars[i]!.ch !== ' ') bad.push(chars.slice(Math.max(0, i - 6), i + 3).map((c) => c.ch).join(''));
            }
          }
          return bad;
        });
        expect(broken, `a line ends inside a word: ${broken.join(' | ')}`).toEqual([]);
        // the exact command is still the text (a <wbr> is not text)
        await expect(line).toHaveText(rt === 'claude' ? 'curl -fsSL https://claude.ai/install.sh | bash' : /curl -fsSL https:\/\/github\.com\/openai\/codex\/releases\/latest\/download\/install\.sh \| sh/);
      }
    });
  }
}

/** ③ a person with no organization: «new organization» · sign out · delete the account */
for (const locale of ['ko', 'en'] as const) {
  for (const width of [1100, 390]) {
    test(`[SID:4906] no organization · the screen has sign-out and delete-account beside «new organization» · ${locale} · ${width}`, async ({ page }) => {
      await open(page, { width, theme: 'L', locale, props: { afterOrgDelete: true }, api: { 'GET /api/auth/me': { data: { member_id: 'u-1', email_verified: true, org_id: null, org_member_id: null, display_name: '송윤재' } } } });
      const card = page.getByTestId('onboarding-org-deleted');
      await expect(card).toBeVisible();
      await expect(page.getByTestId('onboarding-org-deleted-new')).toBeVisible();
      await expect(page.getByTestId('onboarding-org-deleted-logout')).toBeVisible();
      await expect(page.getByTestId('onboarding-org-deleted-delete-account')).toBeVisible();
      await expect(page.getByTestId('onboarding-org-deleted-logout')).toHaveText(locale === 'ko' ? '로그아웃' : 'Logout');
      await expect(page.getByTestId('onboarding-org-deleted-delete-account')).toHaveText(locale === 'ko' ? '계정 삭제' : 'Delete Account');
      await frames(page);
      const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
      expect(scrollWidth, 'no horizontal overflow').toBeLessThanOrEqual(width);
    });
  }
}
