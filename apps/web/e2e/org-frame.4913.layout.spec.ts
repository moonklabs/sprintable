/**
 * story 4913 (UI-R5 · «한 쪽 틀» waves A + B) — the organization frame, measured in Chromium on the REAL screens (roles · trust center · generation connectors · content rules · rewards), bundled with esbuild (not copied) and the real Tailwind build.
 * Rules: the title is the ONE heading and lives in the app bar (not in the body) · the body is the `reading` frame (768 px at 1440, never wider than the phone at 390, no sideways scroll) ·
 * the panel is one step brighter than the page (OKLab ΔL ≥ 0.03 light and dark) and an opened row is one step off the panel (≥ 0.05) · rows are ≥ 56 px tall · every screen starts its body at the same distance from the frame top.
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
  const out = await esbuild.build({
    stdin: {
      contents: `
        import React from 'react'; import { createRoot } from 'react-dom/client'; import { NextIntlClientProvider } from 'next-intl';
        import ko from './messages/ko.json';
        import { TopBarProvider, useTopBar } from './src/components/nav/top-bar-context';
        import Roles from './src/app/(authenticated)/organization/roles/page';
        import Trust from './src/app/(authenticated)/organization/trust/page';
        import Gc from './src/app/(authenticated)/organization/generation-connectors/page';
        import Rules from './src/app/(authenticated)/organization/content-rules/page';
        import Rewards from './src/app/(authenticated)/rewards/page';
        import Channels from './src/app/(authenticated)/organization/channels/page';
        import Events from './src/app/(authenticated)/organization/events/page';
        import { ToastProvider } from './src/components/ui/toast';
        function Bar() { const { title } = useTopBar(); return React.createElement('header', { 'data-testid': 'app-bar', style: { height: '48px', display: 'flex', alignItems: 'center', padding: '0 16px', borderBottom: '1px solid #8884' } }, title); }
        window.__mount = (which) => {
          const Screen = { roles: Roles, trust: Trust, gc: Gc, rules: Rules, rewards: Rewards, channels: Channels, events: Events }[which];
          createRoot(document.getElementById('root')).render(React.createElement(NextIntlClientProvider, { locale: 'ko', messages: ko, timeZone: 'Asia/Seoul' },
            React.createElement(TopBarProvider, null, React.createElement(ToastProvider, null, React.createElement(Bar), React.createElement('main', { 'data-testid': 'main' }, React.createElement(Screen))))));
        };`,
      resolveDir: WEB, loader: 'tsx',
    },
    bundle: true, format: 'iife', platform: 'browser', write: false, logLevel: 'silent', jsx: 'automatic',
    tsconfig: path.join(WEB, 'tsconfig.json'),
    define: { 'process.env.NODE_ENV': '"production"', 'process.env.NEXT_PUBLIC_APP_URL': '"https://dev-app.sprintable.ai"' },
    // the channels screen reads the URL (OAuth return) — a working `next/navigation` for this spec only (the shared stub list returns null for hooks); first in the list so it wins
    plugins: [{
      name: 'nav-stub',
      setup(b: import('esbuild').PluginBuild) {
        b.onResolve({ filter: /^next\/navigation$/ }, () => ({ path: 'next-navigation-stub', namespace: 'nav-stub' }));
        b.onLoad({ filter: /.*/, namespace: 'nav-stub' }, () => ({
          contents: "export const useSearchParams = () => new URLSearchParams(); export const useParams = () => ({}); export const usePathname = () => '/organization/channels'; export const useRouter = () => ({ replace() {}, push() {}, back() {}, refresh() {} });",
          loader: 'js',
        }));
      },
    }, layoutStubPlugin()],
  });
  const js = out.outputFiles[0]!.text;
  const candidates = [...new Set([...js.matchAll(/"([^"\n]+)"/g)].flatMap((m) => m[1]!.split(/\s+/)).filter(Boolean))];
  const compiler = await compile(readFileSync(path.join(APP, 'globals.css'), 'utf8'), { base: APP, onDependency: () => {} });
  const css = (optimize as unknown as (c: string, o?: object) => { code: string })(compiler.build(candidates), { minify: false }).code;
  built = { js, css };
  return built;
}

const MEMBERS = [
  { id: 'm1', user_id: 'u1', name: '오너 하나', email: 'owner@example.com', role: 'owner' },
  { id: 'm2', user_id: 'u2', name: '관리자 둘', email: 'admin@example.com', role: 'admin' },
  { id: 'm3', user_id: 'u3', name: 'A very long member display name that must be cut inside its row and never push the role press out', email: 'a-very-long-address-that-should-also-be-cut-inside-the-row@example.com', role: 'member' },
];
const SUMMARY = [
  { member_id: 'm1', role_key: 'dev', role_label: '개발', hit_rate: 0.82, resolved: 11, computed_at: '2026-11-10T00:00:00Z', pending: 0, name: '오너 하나', member_type: 'human', member_deleted: false },
  { member_id: 'm2', role_key: 'qa', role_label: 'QA', hit_rate: null, resolved: 0, computed_at: '2026-11-10T00:00:00Z', pending: 0, name: '관리자 둘', member_type: 'human', member_deleted: false },
  { member_id: 'm3', role_key: 'dev', role_label: '개발', hit_rate: 0.5, resolved: 4, computed_at: '2026-11-10T00:00:00Z', pending: 1, name: 'A very long member display name that must be cut inside its row', member_type: 'agent', member_deleted: false },
];

type Which = 'roles' | 'trust' | 'gc' | 'rules' | 'rewards' | 'channels' | 'events';
const AVAILABLE = [
  { channel: 'threads', display_name: 'Threads', credential_kind: 'oauth', kind: 'social' },
  { channel: 'wordpress', display_name: 'WordPress', credential_kind: 'pasted_secret', kind: 'blog' },
  { channel: 'sandbox', display_name: 'Sandbox', credential_kind: 'none', kind: 'social' },
];
const CONNS = [
  { id: 'c1', channel: 'threads', account_id: 'acc-1', account_label: '@a_very_long_account_handle_that_must_be_cut_inside_its_row_and_never_push_the_status_chip_out', credential_kind: 'oauth', status: 'active', token_expires_at: null, last_refreshed_at: null, last_error: null, can_auto_refresh: true, connected_by: 'm1', created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-01T00:00:00Z' },
];
// a second, expired connection on the same channel: the row then shows the worst status chip («다시 연결 필요»), the primary «연결 관리» and the «⋯» press together — the widest trailing group a channel row has
const CONNS2 = [...CONNS, { ...CONNS[0], id: 'c2', account_id: 'acc-2', account_label: '@second', status: 'expired', token_expires_at: '2020-01-01T00:00:00Z', can_auto_refresh: false }];
const MEASURE = [
  { key: 'beacon', status: 'not_started', last_seen_at: null, count_7d: null, settings_path: null },
  { key: 'utm', status: 'auto', last_seen_at: null, count_7d: null, settings_path: '/settings' },
  { key: 'ga4', status: 'disconnected', last_seen_at: null, count_7d: null, settings_path: null },
];
const GC = [
  { id: 'g1', provider_key: 'vertex_gemini', label: 'A very long connector name that must wrap inside its row and never push the revoke press out', model_config_json: { image: 'imagen-3', video: 'veo-2' }, location: 'global', status: 'active', created_by: 'm1', created_at: '2026-11-01T00:00:00Z', revoked_at: null },
  { id: 'g2', provider_key: 'vertex_gemini', label: '지난 캠페인', model_config_json: {}, location: 'asia-northeast3', status: 'revoked', created_by: 'm1', created_at: '2026-10-01T00:00:00Z', revoked_at: '2026-10-20T00:00:00Z' },
];
const RULES = { banned_terms: ['무료체험', '100% 보장'], require_utm: true, tone: '친근하게', taxonomy: ['공지', '이벤트'], channel_priority: ['threads', 'wordpress'], brand_kit: { logo_url: 'https://x.example/logo.png', colors: ['#111', '#5b4be0'], fonts: ['Pretendard'] }, generation_budget: { limit_minor: 5000000, currency: 'KRW', period: 'month' }, utm_rules: { enabled: true, default_source: 'sprintable', default_medium: 'social', campaign_from: 'campaign_slug', content_from: 'draft_id' } };

// the events screen — a marketing recipe with a long name, a custom definition with a long name (cyclic: shows «프로젝트에 적용»), a preset
const EVENT_DEFS = [
  { id: 'mk1', key: 'preset.marketing.video_production', org_id: null, name: '영상 제작 (릴스·쇼츠) with a very long recipe name that has to wrap inside its row and never push the apply press out of the panel', description: 'A long description that has to be cut to one line inside the row and never widen the panel on a phone.', payload_schema: { properties: { stage: { enum: ['draft', 'concept_confirmed', 'published'] } } }, stage_metadata: { draft: { role: '크리에이터' }, concept_confirmed: { role: '디렉터', gate: { type: 'concept_approval', approver: 'org_owner' } }, published: { role: '발행자' } }, enabled: true, version: 1 },
  { id: 'ev1', key: 'org.org.work.a_very_long_custom_definition_key_that_must_be_cut_inside_its_row_and_never_push_the_press_out', name: 'A very long custom definition name that must wrap inside its row and never push the status chips out of the panel', org_id: 'org-1', payload_schema: { type: 'object', properties: { stage: { enum: ['draft', 'published'] } }, additionalProperties: false }, stage_metadata: { draft: { role: 'A' }, published: { role: 'B' } }, routing: { escalation: { kind: 'server_derived', target: 'none' }, broadcast: { kind: 'server_derived', target: 'none' } }, block_template: null, enabled: true, version: 3 },
  { id: null, key: 'preset.gate.verdict', name: '게이트 판정', org_id: null, payload_schema: { type: 'object', properties: {}, additionalProperties: false }, routing: { escalation: { kind: 'server_derived', target: 'none' }, broadcast: { kind: 'server_derived', target: 'none' } }, block_template: null, enabled: true, version: 2 },
];

async function open(page: Page, which: Which, scheme: 'light' | 'dark', width: number, height: number) {
  const { js, css } = await build();
  await page.emulateMedia({ colorScheme: scheme });
  await page.setViewportSize({ width, height });
  await page.unrouteAll();
  await page.route('http://preview.test/**', async (route) => {
    const url = new URL(route.request().url());
    const json = (b: unknown) => route.fulfill({ contentType: 'application/json', body: JSON.stringify(b) });
    if (url.pathname === '/') {
      return route.fulfill({ contentType: 'text/html', body: `<!doctype html><html lang="ko" class="${scheme === 'dark' ? 'dark' : ''}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head><body class="bg-ds-background text-ds-ink" style="margin:0"><div id="root"></div></body></html>` });
    }
    if (url.pathname === '/api/organizations/org-1/channel-connections/available-channels') return json({ data: AVAILABLE });
    if (url.pathname === '/api/organizations/org-1/channel-connections') return json({ data: CONNS2 });
    if (url.pathname.endsWith('/app-credentials')) return json({ data: { configured: true, app_id_suffix: 'abcd', effective_source: 'org' } });
    if (url.pathname === '/api/organizations/org-1/measurement-connections') return json({ data: MEASURE });
    if (url.pathname === '/api/organizations/org-1/generation-connectors') return json({ data: { connectors: GC } });
    if (url.pathname === '/api/organizations/org-1/content-rules') return json({ data: { org_id: 'org-1', rules: RULES, version: 3, updated_at: '2026-11-10T00:00:00Z', updated_by: { member_id: 'm1', name: '송윤재' } } });
    if (url.pathname === '/api/organizations/org-1/generation-budget') return json({ data: { limit_minor: 5000000, spent_minor: 1200000, remaining_minor: 3800000, currency: 'KRW', period: 'month' } });
    if (url.pathname === '/api/rewards/leaderboard') return json({ data: [{ member_id: 'm1', balance: 120 }, { member_id: 'm2', balance: -30 }] });
    if (url.pathname === '/api/rewards') return json({ data: [{ id: 'r1', member_id: 'm1', amount: 50, reason: 'A very long reason that has to wrap inside its row and never push the amount out of the panel on a phone', created_at: '2026-11-11T00:00:00Z' }] });
    if (url.pathname === '/api/team-members') return json({ data: [{ id: 'm1', name: '오너 하나', type: 'human' }, { id: 'm2', name: '관리자 둘', type: 'human' }] });
    if (url.pathname === '/api/org-members') return json({ data: MEMBERS });
    if (url.pathname === '/api/events/definitions') return json(EVENT_DEFS);
    if (url.pathname.startsWith('/api/events/definitions/publish-history')) return json([]); // the opened row's history reads an array
    if (url.pathname === '/api/me') return json({ data: { user_id: 'u-me' } });
    if (url.pathname === '/api/trust-scores/org-summary') return json({ members: SUMMARY });
    if (url.pathname.startsWith('/api/trust-scores/history')) return json({ snapshots: [{ computed_at: '2026-11-09T00:00:00Z', hit_rate: 0.8, resolved: 9 }, { computed_at: '2026-11-08T00:00:00Z', hit_rate: 0.7, resolved: 8 }] });
    return json({ data: [] });
  });
  await page.addInitScript(() => {
    (window as unknown as { process: unknown }).process = { env: {} };
    (window as unknown as { __dashboardCtx: unknown }).__dashboardCtx = { orgId: 'org-1', orgMemberships: [{ orgId: 'org-1', orgName: 'Org', orgSlug: 'org', role: 'admin' }], projectMemberships: [], projectId: 'p1', currentTeamMemberId: 'tm1' };
  });
  await page.goto('about:blank');
  await page.goto('http://preview.test/');
  await page.addScriptTag({ content: js });
  await page.evaluate((w) => (window as unknown as { __mount: (x: string) => void }).__mount(w), which);
  await page.locator('[data-slot="ds-row-list-item"]').first().waitFor();
}

/** OKLab L of a css colour (rgb/rgba) — same formula as styles/layer-rule.test.ts */
const lightnessOf = (css: string) => {
  const m = /rgba?\((\d+)[, ]+(\d+)[, ]+(\d+)/.exec(css);
  if (!m) return NaN;
  const lin = (v: number) => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  const [r, g, b] = [lin(+m[1]!), lin(+m[2]!), lin(+m[3]!)];
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const mm = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return 0.2104542553 * l + 0.793617785 * mm - 0.0040720468 * s;
};

for (const scheme of ['light', 'dark'] as const) {
  for (const [width, height] of [[1440, 900], [390, 844]] as const) {
    test.describe(`${scheme} ${width}`, () => {
      for (const which of ['roles', 'trust', 'gc', 'rules', 'rewards', 'channels', 'events'] as const) {
        test(`${which} — one heading in the app bar · reading frame · no sideways scroll · layers`, async ({ page }) => {
          await open(page, which, scheme, width, height);
          // one heading, in the bar, none in the body
          expect(await page.locator('h1').count()).toBe(1);
          expect(await page.locator('[data-testid="app-bar"] h1').count()).toBe(1);
          expect(await page.locator('[data-testid="main"] h1').count()).toBe(0);
          // the frame
          const frame = (await page.locator('[data-slot="ds-page-frame"]').first().boundingBox())!;
          if (width >= 800) {
            expect(Math.round(frame.width)).toBe(768);
            expect(Math.round(frame.x)).toBe(Math.round((width - 768) / 2));
          } else {
            expect(frame.width).toBeLessThanOrEqual(width);
          }
          expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
          // the body starts at the same y on both screens (frame top + outer padding, then the head)
          // every screen's body starts at the frame padding (24 / 16): the page head, or — rewards, no description — the first panel
          const first = (await page.locator(which === 'rewards' ? '[data-slot="ds-row-list"]' : '[data-slot="ds-page-head"]').first().boundingBox())!;
          expect(Math.round(first.y - frame.y)).toBe(width >= 640 ? 24 : 16);
          // the frame paints no background of its own (the shell owns the page layer — a painted frame shows as a block of another colour)
          expect(await page.locator('[data-slot="ds-page-frame"]').first().evaluate((el) => getComputedStyle(el).backgroundColor)).toBe('rgba(0, 0, 0, 0)');
          // layers: the panel is one step brighter than the page
          const lPage = lightnessOf(await page.evaluate(() => getComputedStyle(document.body).backgroundColor));
          const lPanel = lightnessOf(await page.locator('[data-slot="ds-row-list"]').first().evaluate((el) => getComputedStyle(el).backgroundColor));
          expect(Math.abs(lPanel - lPage)).toBeGreaterThanOrEqual(0.03);
          // rows are ≥ 56 tall and never run past the panel edge
          const panel = (await page.locator('[data-slot="ds-row-list"]').first().boundingBox())!;
          for (const row of await page.locator('[data-slot="ds-list-row"]').all()) {
            const b = (await row.boundingBox())!;
            expect(b.height).toBeGreaterThanOrEqual(55.5);
            expect(b.x + b.width).toBeLessThanOrEqual(panel.x + panel.width + 1);
            // nothing pressable inside a row is cut off by the panel edge (the panel clips what runs past it)
            for (const press of await row.locator('button, a, [data-slot="ds-chip"]').all()) {
              const pb = await press.boundingBox();
              if (!pb) continue;
              expect(pb.x + pb.width, await press.innerText()).toBeLessThanOrEqual(panel.x + panel.width + 1);
              expect(pb.x).toBeGreaterThanOrEqual(panel.x - 1);
            }
          }
        });
      }
    });
  }
}

test('trust — an opened row is one step off the panel and keeps its text inside (light + dark, phone)', async ({ page }) => {
  for (const scheme of ['light', 'dark'] as const) {
    await open(page, 'trust', scheme, 390, 844);
    await page.locator('[data-testid="trust-history-toggle"]').first().click();
    const detail = page.locator('[data-slot="ds-row-detail"]').first();
    await detail.waitFor();
    const lPanel = lightnessOf(await page.locator('[data-slot="ds-row-list"]').first().evaluate((el) => getComputedStyle(el).backgroundColor));
    const lDetail = lightnessOf(await detail.evaluate((el) => getComputedStyle(el).backgroundColor));
    expect(Math.abs(lDetail - lPanel)).toBeGreaterThanOrEqual(0.05);
    expect(await detail.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  }
});

test('channels — an opened channel row is one step off the panel, keeps its long account name inside, and the footnote/menu stay in the frame (light + dark, phone)', async ({ page }) => {
  for (const scheme of ['light', 'dark'] as const) {
    await open(page, 'channels', scheme, 390, 844);
    await page.locator('#channel-row-threads').dblclick(); // double-click = open the row
    const detail = page.locator('[data-testid="channel-section"] [data-slot="ds-row-detail"]').first();
    await detail.waitFor();
    const lPanel = lightnessOf(await page.locator('[data-slot="ds-row-list"]').first().evaluate((el) => getComputedStyle(el).backgroundColor));
    const lDetail = lightnessOf(await detail.evaluate((el) => getComputedStyle(el).backgroundColor));
    expect(Math.abs(lDetail - lPanel)).toBeGreaterThanOrEqual(0.05);
    expect(await detail.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
    // every footnote line stays inside the panel
    const panel = (await page.locator('[data-slot="ds-row-list"]').first().boundingBox())!;
    for (const note of await page.locator('[data-slot="ds-row-footnote"]').all()) {
      const b = (await note.boundingBox())!;
      expect(b.x + b.width).toBeLessThanOrEqual(panel.x + panel.width + 1);
    }
  }
});

test('channels — on the narrowest phone (320) nothing pressable in a row is cut off by the panel edge, even with the status chip + «연결 관리» + «⋯» together', async ({ page }) => {
  for (const scheme of ['light', 'dark'] as const) {
    await open(page, 'channels', scheme, 320, 640);
    const panel = (await page.locator('[data-slot="ds-row-list"]').first().boundingBox())!;
    for (const press of await page.locator('[data-testid="channel-section"] [data-slot="ds-list-row"]').first().locator('button, a, [data-slot="ds-chip"]').all()) {
      const pb = (await press.boundingBox())!;
      expect(pb.x + pb.width, await press.innerText()).toBeLessThanOrEqual(panel.x + panel.width + 1);
      expect(pb.x).toBeGreaterThanOrEqual(panel.x - 1);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  }
});

test('channels — a row whose right-hand group is wider than the row wraps it onto a second line instead of clipping it (320, a stand-in for longer labels · English)', async ({ page }) => {
  await open(page, 'channels', 'light', 320, 640);
  const row = page.locator('[data-testid="channel-section"] [data-slot="ds-list-row"]').first();
  const before = (await row.boundingBox())!;
  // widen the group by 140 px — what a longer button label or a longer chip would do
  await row.evaluate((el) => {
    const group = el.querySelector('button')!.parentElement as HTMLElement;
    const pad = document.createElement('span');
    pad.style.cssText = 'display:inline-block;width:140px;height:20px';
    pad.setAttribute('data-testid', 'pad');
    group.appendChild(pad);
  });
  const after = (await row.boundingBox())!;
  expect(after.height).toBeGreaterThan(before.height); // it grew: the group went to a second line
  const panel = (await page.locator('[data-slot="ds-row-list"]').first().boundingBox())!;
  for (const press of await row.locator('button, a, [data-slot="ds-chip"], [data-testid="pad"]').all()) {
    const pb = (await press.boundingBox())!;
    expect(pb.x + pb.width).toBeLessThanOrEqual(panel.x + panel.width + 1);
    expect(pb.x).toBeGreaterThanOrEqual(panel.x - 1);
  }
});

test('events — the development tab: both lists inside the frame, an opened definition row is one step off the panel, nothing is cut (light + dark, phone 390 + 320)', async ({ page }) => {
  for (const scheme of ['light', 'dark'] as const) {
    for (const [width, height] of [[390, 844], [320, 640]] as const) {
      await open(page, 'events', scheme, width, height);
      await page.getByRole('tab', { name: /./ }).nth(1).click(); // the development tab
      await page.locator('[data-testid="events-custom-list"]').waitFor();
      expect(await page.locator('[data-testid="events-custom-list"] [data-slot="ds-list-row"]').count()).toBe(1);
      expect(await page.locator('[data-testid="events-preset-list"] [data-slot="ds-list-row"]').count()).toBe(1);
      const row = page.locator('[data-testid^="event-def-row-org."]').first();
      await row.locator('[data-row-main]').dblclick({ position: { x: 24, y: 8 } }); // double-click on the row's own left edge (not a press) = open the row
      const detail = row.locator('[data-slot="ds-row-detail"]');
      await detail.waitFor();
      const panel = page.locator('[data-testid="events-custom-list"]');
      const lPanel = lightnessOf(await panel.evaluate((el) => getComputedStyle(el).backgroundColor));
      const lDetail = lightnessOf(await detail.evaluate((el) => getComputedStyle(el).backgroundColor));
      expect(Math.abs(lDetail - lPanel), `${scheme} ${width}: panel ${await panel.evaluate((el) => getComputedStyle(el).backgroundColor)} detail ${await detail.evaluate((el) => getComputedStyle(el).backgroundColor)}`).toBeGreaterThanOrEqual(0.05);
      expect(await detail.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
      // nothing pressable in any row is cut off by the panel edge (read all rects in one go — no waiting on a node that re-renders)
      const pb0 = (await panel.boundingBox())!;
      const rects = await page.locator('[data-slot="ds-list-row"]').evaluateAll((rows) => rows.flatMap((r) => [...r.querySelectorAll('button, a, [data-slot="ds-chip"]')].map((e) => { const b = e.getBoundingClientRect(); return { x: b.x, w: b.width, h: b.height, t: (e.textContent || '').trim() }; })).filter((r) => r.w > 0 && r.h > 0)); // (the inactive tab's rows are hidden — no box)
      expect(rects.length).toBeGreaterThan(0);
      for (const r of rects) {
        expect(r.x + r.w, r.t).toBeLessThanOrEqual(pb0.x + pb0.width + 1);
        expect(r.x, r.t).toBeGreaterThanOrEqual(pb0.x - 1);
      }
    }
  }
});

test('events — the marketing tab: a recipe row keeps «프로젝트에 적용» inside the panel and shows its roles/connections only when opened (light + dark, phone 390 + 320)', async ({ page }) => {
  for (const scheme of ['light', 'dark'] as const) {
    for (const [width, height] of [[390, 844], [320, 640]] as const) {
      await open(page, 'events', scheme, width, height);
      const list = page.locator('[data-testid="recipe-list"]');
      await list.waitFor();
      expect(await list.locator('[data-testid="recipe-card-roles"]').count()).toBe(0);
      const panel = (await list.boundingBox())!;
      const apply = list.getByRole('button', { name: '프로젝트에 적용' });
      const ab = (await apply.boundingBox())!;
      expect(ab.x + ab.width).toBeLessThanOrEqual(panel.x + panel.width + 1);
      expect(ab.x).toBeGreaterThanOrEqual(panel.x - 1);
      await list.locator('[data-row-main]').dblclick({ position: { x: 24, y: 8 } });
      await list.locator('[data-testid="recipe-card-roles"]').waitFor();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
    }
  }
});
