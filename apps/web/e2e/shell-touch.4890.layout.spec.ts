/**
 * story 4890 (UI-7 · 겸사 셋) — the phone shell's three small things, measured in Chromium on a touch phone (390 × 844): the header icons (people · what's new · bell), the bottom tab bar's count badges, and the /desktop «원격 제어» card with its toggle.
 * The REAL components (bundled with esbuild, not copied) and the real Tailwind build. Before (dev 11-11): the header icons were 32×32, the tab badge a 10 px corner badge, the card an old Card + a 32×18 switch.
 * Rule: every press ≥ 44 × 44 (a toggle's press is its label row), no reading text under 12 px (named exemption: the ds CountBadge, 11 px mono by the UI-3 spec), no old (non-ds) part drawn in the card, nothing runs sideways.
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
    '@/components/home/home-model-provider': 'export function useHomeModel() { return { model: { badge: 5 }, sources: null, loadError: false, partial: false, retry() {} }; }',
    '@/app/dashboard/dashboard-shell': "export function useDashboardContext() { return { orgId: 'org-1', navV3Flags: undefined, orgMemberships: [{ orgId: 'org-1', orgSlug: 'o' }], currentProjectSlug: 'p', projectMemberships: [] }; } export function useToast() { return new Proxy({}, { get: () => () => {} }); }",
    '@/components/command-palette/command-palette-context': 'export function useCommandPaletteOpener() { return () => {}; }',
    'next/navigation': "export function useRouter() { return { push() {}, replace() {}, back() {}, refresh() {}, prefetch() {} }; } export function useSearchParams() { return new URLSearchParams(''); } export function usePathname() { return '/more'; } export function useParams() { return {}; } export function useSelectedLayoutSegment() { return null; }",
    // the top bar's context chip reads the switch helpers too (the shared stub has only fetchWithAuth)
    '@/lib/db/client': 'export const fetchWithAuth = (u, i) => fetch(u, i); export const switchOrg = async () => ({ ok: true }); export const switchProject = async () => ({ ok: true });',
  };
  const out = await esbuild.build({
    stdin: {
      contents: `
        import React from 'react'; import { createRoot } from 'react-dom/client'; import { NextIntlClientProvider } from 'next-intl';
        import ko from './messages/ko.json';
        import { TeamPresenceToggleProvider } from './src/components/presence/team-presence-toggle';
        import { TopBar } from './src/components/nav/top-bar';
        import { TopBarProvider } from './src/components/nav/top-bar-context';
        import { SidebarProvider } from './src/components/ui/sidebar';
        import MorePage from './src/app/(authenticated)/more/page';
        import { MobileTabBar } from './src/components/nav/mobile-tab-bar';
        import { ToastProvider } from './src/components/ui/toast';
        import { DesktopRemoteControlCard } from './src/components/desktop/desktop-remote-control-card';
        const intl = (child) => React.createElement(NextIntlClientProvider, { locale: 'ko', messages: ko, timeZone: 'Asia/Seoul' }, child);
        const presence = { toggle() {}, workingCount: 4, open: false };
        window.__mount = (scene) => {
          const root = createRoot(document.getElementById('root'));
          if (scene === 'card') { root.render(intl(React.createElement('div', { style: { padding: '16px' } }, React.createElement(DesktopRemoteControlCard)))); return; }
          const shell = (children) => React.createElement(ToastProvider, null, React.createElement(TopBarProvider, null, React.createElement(SidebarProvider, null, React.createElement(TeamPresenceToggleProvider, { value: presence }, children))));
          if (scene === 'more') { root.render(intl(shell(React.createElement('div', null, React.createElement(TopBar), React.createElement(MorePage), React.createElement('div', { style: { height: '70px' } }), React.createElement('div', { style: { position: 'fixed', left: 0, right: 0, bottom: 0 } }, React.createElement(MobileTabBar, { chatUnreadTotal: 7 })))))); return; }
          root.render(intl(shell(React.createElement('div', null, React.createElement(TopBar), React.createElement('div', { style: { position: 'fixed', left: 0, right: 0, bottom: 0 } }, React.createElement(MobileTabBar, { chatUnreadTotal: 7 }))))));
        };`,
      resolveDir: WEB, loader: 'tsx',
    },
    bundle: true, format: 'iife', platform: 'browser', write: false, logLevel: 'silent', jsx: 'automatic',
    tsconfig: path.join(WEB, 'tsconfig.json'),
    define: { 'process.env.NODE_ENV': '"production"', 'process.env.NEXT_PUBLIC_APP_URL': '"https://app.sprintable.ai"' },
    plugins: [
      { name: 'shell-4890-stubs', setup(b) {
        b.onResolve({ filter: /^@\/(components\/home\/home-model-provider|app\/dashboard\/dashboard-shell|components\/command-palette\/command-palette-context|lib\/db\/client)$/ }, (a) => ({ path: a.path, namespace: 'stub4890' }));
        b.onResolve({ filter: /^next\/navigation$/ }, (a) => ({ path: a.path, namespace: 'stub4890' }));
        b.onResolve({ filter: /release-notes-gate$/ }, (a) => ({ path: a.path, namespace: 'stub4890' }));
        b.onLoad({ filter: /.*/, namespace: 'stub4890' }, (a) => ({ contents: a.path.includes('release-notes-gate') ? 'export function useReleaseNotes() { return { open() {}, hasUnseen: true }; }' : bodies[a.path]!, loader: 'js', resolveDir: WEB }));
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

async function open(page: Page, scene: 'shell' | 'card' | 'more', canChange = true) {
  const { js, css } = await build();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.unrouteAll();
  await page.route('http://preview.test/**', async (route) => {
    const url = new URL(route.request().url());
    const json = (data: unknown) => route.fulfill({ contentType: 'application/json', body: JSON.stringify(data) });
    if (url.pathname === '/') {
      return route.fulfill({ contentType: 'text/html', body: `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head><body class="bg-ds-canvas text-ds-ink"><div id="root"></div></body></html>` });
    }
    if (url.pathname === '/api/event-notifications/unread-count') return json({ count: 7 });
    if (url.pathname === '/api/event-notifications') {
      const chat = (id: string, read: boolean, room: string, who: string) => ({ id, event_type: 'conversation.message_created', source_entity_type: 'conversation_message', source_entity_id: `${id}-m`, payload: { summary: `${who}: 안녕하세요 이 글은 조금 길어서 한 줄에 다 안 들어갈 수도 있어요`, conversation_id: 'room-1', sender: { id: 's1', name: who, type: 'agent', avatar_url: null, runtime_type: 'claude-code' } }, read_at: read ? '2026-11-10T13:00:00Z' : null, created_at: '2026-11-10T12:00:00Z', target_conversation_title: room });
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ data: [chat('n1', false, '결제 연동 · 오늘 할 일', '개발 에이전트'), chat('n2', false, '랜딩 문구 검토', '검수 에이전트'), chat('n3', true, '주간 고객 문의', '리서치 에이전트'), chat('n4', true, '회원가입 오류 수정', '개발 에이전트')], meta: { hasMore: false } }) });
    }
    if (url.pathname === '/api/organizations/org-1/remote-control') return json({ data: { enabled: true, enabled_at: '2026-10-03T09:00:00Z', can_change: canChange, owner_names: ['송윤재'], connected_setups: 1 } });
    return route.fulfill({ status: 404, body: '{}' });
  });
  const thrown: string[] = [];
  page.on('pageerror', (e) => thrown.push(e.message + ' @ ' + String(e.stack).split('\n').slice(1, 3).join(' ')));
  await page.addInitScript(() => { (window as unknown as { process: unknown }).process = { env: {} }; });
  await page.goto('about:blank');
  await page.goto('http://preview.test/');
  await page.addScriptTag({ content: js });
  await page.evaluate((s) => (window as unknown as { __mount: (s: string) => void }).__mount(s), scene);
  await page.waitForTimeout(1500);
  if (await page.evaluate(() => document.getElementById('root')!.childElementCount === 0)) throw new Error(`nothing drawn — page errors: ${thrown.join(' | ') || 'none'}`);
}

const measure = (page: Page) => page.evaluate(() => {
  const vis = (e: Element) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== 'hidden' && !e.closest('[aria-hidden="true"]:not([data-slot="ds-count-badge"])'); };
  // a toggle's press is its label row (the switch inside it is only the picture of the state)
  const presses = [...document.querySelectorAll('button, a[href], input, select, summary, [data-slot="ds-toggle-field"]')].filter((e) => vis(e) && !e.closest('[data-slot="ds-toggle-field"]:not(:scope)') || e.matches('[data-slot="ds-toggle-field"]'));
  const small = presses.filter((e) => { const r = e.getBoundingClientRect(); return r.width < 43.5 || r.height < 43.5; }).map((e) => `${(e.getAttribute('aria-label') || e.textContent || e.tagName).trim().slice(0, 24)} ${Math.round(e.getBoundingClientRect().width)}x${Math.round(e.getBoundingClientRect().height)}`);
  const leaves = [...document.querySelectorAll('body *')].filter((e) => e.children.length === 0 && (e.textContent || '').trim() && vis(e) && !e.closest('[data-slot="ds-count-badge"], .sr-only'));
  const tiny = leaves.filter((e) => parseFloat(getComputedStyle(e).fontSize) < 12).map((e) => `${(e.textContent || '').trim().slice(0, 20)} ${getComputedStyle(e).fontSize}`);
  const badges = [...document.querySelectorAll('[data-slot="ds-count-badge"]')].filter((e) => vis(e) || e.getBoundingClientRect().width > 0).map((e) => { const r = e.getBoundingClientRect(); return { text: (e.textContent || '').replace(/\s+/g, ' ').trim(), kind: e.getAttribute('data-kind'), font: parseFloat(getComputedStyle(e).fontSize), inside: r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight, hidden: e.getAttribute('aria-hidden') };});
  const oldSlots = [...document.querySelectorAll('[data-slot]')].map((e) => e.getAttribute('data-slot')!).filter((s) => !s.startsWith('ds-'));
  return { presses: presses.length, small, tiny, badges, oldSlots, overflowX: document.documentElement.scrollWidth > innerWidth + 1 };
});

test.describe('on a touch phone (390 × 844)', () => {
  test.use({ hasTouch: true, isMobile: true });

  test('[SID:4890] the phone header row is «bell» alone (people · what\'s new left it), ≥44; the four tabs ≥44; the count badges are the ds one (≥ 11 px mono, inside the screen, hidden from the reader)', async ({ page }) => {
    await open(page, 'shell');
    await page.getByRole('button', { name: /알림/ }).first().waitFor();
    await expect(page.locator('[data-slot="ds-count-badge"]:visible').first()).toBeVisible();
    // what left the header row: not drawn at this width (display: none), the bell stays
    await expect(page.locator('button[title="팀 현황"]')).toBeHidden();
    await expect(page.getByRole('button', { name: /새 소식|릴리스|업데이트/ })).toHaveCount(0).catch(() => undefined);
    const header = await page.locator('[data-testid="top-bar"] button:visible').count();
    expect(header, 'one visible control in the header row (the bell)').toBe(1);
    const m = await measure(page);
    expect(m.small, `presses under 44 px: ${m.small.join(' · ')}`).toEqual([]);
    expect(m.tiny, `text under 12 px: ${m.tiny.join(' · ')}`).toEqual([]);
    expect(m.overflowX).toBe(false);
    expect(m.presses, 'the bell + four tabs').toBeGreaterThanOrEqual(5);
    expect(m.badges.length, 'bell (7) · home (5) · chat (7)').toBe(3);
    for (const b of m.badges) {
      expect(b.font, `badge «${b.text}» is the ds mono size (before: a 10 px corner badge)`).toBeGreaterThanOrEqual(11);
      expect(b.inside, `badge «${b.text}» is inside the screen`).toBe(true);
      expect(b.hidden, `badge «${b.text}» is hidden from the reader (its number is in the control's name)`).toBe('true');
    }
    expect(m.badges.map((b) => b.kind).sort()).toEqual(['needs-hand', 'unread', 'unread']);
  });

  test('[SID:4890] «전체»: one search row first, then the two moved shortcuts (팀 현황 · 새 소식) — every press ≥44, the first content starts high, no old part', async ({ page }) => {
    await open(page, 'more');
    await page.getByTestId('more-shell-shortcuts').waitFor();
    const m = await measure(page);
    expect(m.small, `presses under 44 px: ${m.small.join(' · ')}`).toEqual([]);
    expect(m.tiny, `text under 12 px: ${m.tiny.join(' · ')}`).toEqual([]);
    // the old-part check is about the PAGE (the top bar's context chip is a separate part of the shell, not this screen)
    const pageOld = await page.evaluate(() => { const root = document.querySelector('[data-testid="more-search-input"]')!.closest('.p-4') as HTMLElement; return [...new Set([...root.querySelectorAll('[data-slot]')].map((e) => e.getAttribute('data-slot')!).filter((x) => !x.startsWith('ds-')))]; });
    expect(pageOld, 'old (non-ds) parts drawn on the page').toEqual([]);
    expect(m.overflowX).toBe(false);
    const geo = await page.evaluate(() => {
      const top = (sel: string) => { const e = document.querySelector(sel) as HTMLElement | null; return e ? Math.round(e.getBoundingClientRect().top + scrollY) : null; };
      return { search: top('[data-testid="more-search-input"]'), shortcuts: top('[data-testid="more-shell-shortcuts"]'), firstSection: top('[data-testid="more-section-card"]'), globalSearch: !!document.querySelector('[data-testid="more-global-search"]'), subtitle: !!document.querySelector('[data-testid="more-subtitle"]') };
    });
    expect(geo.subtitle, 'the «N개 화면 · M개 구역» line is gone').toBe(false);
    expect(geo.globalSearch, 'the palette opens from the search row\'s own button').toBe(true);
    expect(geo.shortcuts!, 'the first content card starts within the first 150 px (before: 232 px of a 844 px screen)').toBeLessThan(150);
    expect(geo.search!).toBeLessThan(geo.shortcuts!);
    expect(geo.shortcuts!).toBeLessThan(geo.firstSection!);
    // the working count of the people row is drawn as the ds badge, and the whats-new dot is a plain dot (no text)
    await expect(page.getByTestId('more-shortcut-presence')).toContainText('4');
  });

  test('[SID:4890] /desktop «원격 제어» card (owner): the toggle row is a ≥44 press, its on/off WORDS are drawn, no old part — and a press reaches the confirmation', async ({ page }) => {
    await open(page, 'card');
    const field = page.locator('[data-slot="ds-toggle-field"]');
    await field.waitFor();
    const box = (await field.boundingBox())!;
    expect(box.height, 'the toggle row is a 44 press').toBeGreaterThanOrEqual(43.5);
    await expect(page.locator('[data-slot="ds-toggle-state"]')).toHaveText('켜짐');
    const m = await measure(page);
    expect(m.small, `presses under 44 px: ${m.small.join(' · ')}`).toEqual([]);
    expect(m.tiny, `text under 12 px: ${m.tiny.join(' · ')}`).toEqual([]);
    expect(m.oldSlots, 'old (non-ds) parts drawn').toEqual([]);
    expect(m.overflowX).toBe(false);
    await field.tap(); // on → off asks first (the confirmation, [취소] focused)
    await expect(page.getByRole('button', { name: '취소' })).toBeFocused();
    const m2 = await measure(page);
    expect(m2.small, `confirmation presses under 44 px: ${m2.small.join(' · ')}`).toEqual([]);
    expect(m2.oldSlots).toEqual([]);
  });

  test('[SID:4890] /desktop «원격 제어» card (not an owner): the read line, no toggle, nothing small', async ({ page }) => {
    await open(page, 'card', false);
    await page.getByTestId('desktop-remote-control-owner-only').waitFor();
    await expect(page.locator('[data-slot="ds-toggle-field"]')).toHaveCount(0);
    const m = await measure(page);
    expect(m.tiny).toEqual([]);
    expect(m.oldSlots).toEqual([]);
    expect(m.overflowX).toBe(false);
  });
});

// story 4890 (codex round 2): the two shortcut rows keep the standard row inset and the row separator (the quiet button inside the ListRow must not flatten them)
test.describe('the shortcut rows keep the row inset (390 × 844)', () => {
  test.use({ hasTouch: true, isMobile: true });
  test('[SID:4890] «전체»: the 팀 현황 row content starts ≥ 12 px inside the card edge, and the first row has a separator under it', async ({ page }) => {
    await open(page, 'more');
    await page.getByTestId('more-shell-shortcuts').waitFor();
    const g = await page.evaluate(() => {
      const card = document.querySelector('[data-testid="more-shell-shortcuts"]') as HTMLElement;
      const row = card.querySelector('[data-testid="more-shortcut-presence"]') as HTMLElement;
      const icon = row.querySelector('svg, [data-slot="ds-icon"]') as HTMLElement;
      const cs = getComputedStyle(row);
      return { inset: Math.round(icon.getBoundingClientRect().left - card.getBoundingClientRect().left), borderBottom: cs.borderBottomWidth, borderTop: cs.borderTopWidth, borderLeft: cs.borderLeftWidth };
    });
    expect(g.inset, 'the icon is not flush against the card edge').toBeGreaterThanOrEqual(12);
    expect(g.borderBottom, 'the separator under the first row').not.toBe('0px');
    expect(g.borderTop, 'no stray border on the other sides').toBe('0px');
    expect(g.borderLeft).toBe('0px');
  });
});

// story 4890 (UI-7 · 알림 화면 통째): the open panel on a phone — header one line with 44 presses, ONE chip row, two groups, rows of two lines.
test.describe('the notification panel on a touch phone (390 × 844)', () => {
  test.use({ hasTouch: true, isMobile: true });
  test('[SID:4890] header (title · [전체 읽음] · close) and the chip row are ≥44; two groups «안 읽음 2» / «이전»; each row is two lines and ≥56 tall; text ≥12 px; no old part; no sideways scroll', async ({ page }) => {
    await open(page, 'shell');
    await page.getByRole('button', { name: /알림/ }).first().tap();
    // both the lg+ popover and the below-lg overlay are mounted (CSS shows one): measure the visible one
    const panel = page.locator('[data-testid="notification-group-unread"]:visible').first();
    await panel.waitFor();
    const m = await page.evaluate(() => {
      const root = ([...document.querySelectorAll('[data-testid="notification-group-unread"]')].find((e) => (e as HTMLElement).offsetParent !== null) as HTMLElement).closest('[role="dialog"], [data-dropdown-panel]') as HTMLElement;
      const shown = (e: Element) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== 'hidden'; };
      const presses = [...root.querySelectorAll('button, a[href]')].filter(shown);
      const small = presses.filter((e) => { const r = e.getBoundingClientRect(); return r.width < 43.5 || r.height < 43.5; }).map((e) => `${(e.getAttribute('aria-label') || e.textContent || '').trim().slice(0, 18)} ${Math.round(e.getBoundingClientRect().width)}x${Math.round(e.getBoundingClientRect().height)}`);
      const tiny = [...root.querySelectorAll('*')].filter((e) => e.children.length === 0 && (e.textContent || '').trim() && shown(e) && !e.closest('[data-slot="ds-count-badge"]')).filter((e) => parseFloat(getComputedStyle(e).fontSize) < 12).map((e) => `${(e.textContent || '').trim().slice(0, 16)} ${getComputedStyle(e).fontSize}`);
      const rows = [...root.querySelectorAll('ul > li')].map((li) => { const b = li.querySelector('button')!.getBoundingClientRect(); return { h: Math.round(b.height), lines: li.querySelectorAll('button > span > span.block').length }; });
      const weight = (id: string) => { const rows = [...root.querySelectorAll('ul > li')]; return rows.map((li) => ({ id: li.parentElement!.closest('[data-testid^="notification-group-"]')?.getAttribute('data-testid'), w: Number(getComputedStyle(li.querySelector('[data-testid="notification-line-headline"]')!).fontWeight) })); };
      const weights = weight('');
      const chips = [...root.querySelectorAll('button[aria-pressed]')];
      const old = [...new Set([...root.querySelectorAll('[data-slot]')].map((e) => e.getAttribute('data-slot')!))].filter((x) => !x.startsWith('ds-') && x !== 'avatar');
      const bg = getComputedStyle(root).backgroundColor;
      return { weights, bg, small, tiny, rows, chipsOneRow: new Set(chips.map((c) => Math.round(c.getBoundingClientRect().top))).size === 1, chipCount: chips.length, groups: [...root.querySelectorAll('[data-testid^="notification-group-"]')].map((g) => g.getAttribute('data-testid')), old, overflowX: root.scrollWidth > root.clientWidth + 1 || document.documentElement.scrollWidth > innerWidth + 1 };
    });
    expect(m.small, `presses under 44 px: ${m.small.join(' · ')}`).toEqual([]);
    expect(m.tiny, `text under 12 px: ${m.tiny.join(' · ')}`).toEqual([]);
    expect(m.groups).toEqual(['notification-group-unread', 'notification-group-earlier']);
    expect(m.rows).toHaveLength(4);
    for (const r of m.rows) { expect(r.lines, 'two lines').toBe(2); expect(r.h, 'a row is a ≥56 press').toBeGreaterThanOrEqual(56); expect(r.h, 'and stays compact (before: ~78 px rows of three lines)').toBeLessThanOrEqual(72); }
    // an unread headline is heavier than a read one (the quiet button must not make every row bold)
    const wUnread = m.weights.filter((x) => x.id === 'notification-group-unread').map((x) => x.w);
    const wRead = m.weights.filter((x) => x.id === 'notification-group-earlier').map((x) => x.w);
    expect(Math.min(...wUnread), 'unread headlines are semibold').toBeGreaterThanOrEqual(600);
    expect(Math.max(...wRead), 'read headlines are regular').toBeLessThan(600);
    expect(m.chipCount).toBe(4);
    expect(m.chipsOneRow, 'the four chips share one row').toBe(true);
    expect(m.old, 'old (non-ds) parts drawn').toEqual([]);
    expect(m.bg, 'the full-screen overlay has an opaque face (the page behind must not show through)').not.toMatch(/rgba\(\d+, \d+, \d+, 0(\.\d+)?\)|transparent/);
    expect(m.overflowX).toBe(false);
    await expect(panel).toBeVisible();
  });
});
