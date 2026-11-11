/**
 * story 4887 (UI-4) — the room head on a PHONE lives in the shell's own header row. Measured in Chromium on a touch phone (390 × 844 and 320 × 640): the REAL `TopBar` (with its bell) + `TopBarProvider` + `TopBarSlot` carrying the REAL `RoomBarTitle`, the real `ChatInput` with the hint ChatView passes on a phone,
 * a timeline, and a 56 px stand-in for the bottom tab bar (its real height). Before (dev, 5612): the shell row (48) + a head block under it (135) = 183 px of top, the composer region 122 → at 390 × 844 the reading column was 482 (the version before 5612: 635).
 * Rule: the top is the shell row alone (48), the reading column is at least what it was before 5612 (635 at 390 × 844), nothing runs past the screen at 390 or 320, every press ≥ 44 × 44, the people popover is on the screen with the participants and the «+».
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
    '@/app/dashboard/dashboard-shell': "export function useDashboardContext() { return { orgId: 'org-1', navV3Flags: undefined, orgMemberships: [{ orgId: 'org-1', orgSlug: 'o' }], currentProjectSlug: 'p', projectMemberships: [{ projectId: 'p1', projectName: 'AC4 project' }], currentTeamMemberId: 'me-1', projectId: 'p1' }; } export function useToast() { return new Proxy({}, { get: () => () => {} }); }",
    '@/components/command-palette/command-palette-context': 'export function useCommandPaletteOpener() { return () => {}; }',
    '@/components/home/home-model-provider': 'export function useHomeModel() { return { model: { badge: 5 }, sources: null, loadError: false, partial: false, retry() {} }; }',
    'next/navigation': "export function useRouter() { return { push() {}, replace() {}, back() {}, refresh() {}, prefetch() {} }; } export function useSearchParams() { return new URLSearchParams(''); } export function usePathname() { return '/chats/c1'; } export function useParams() { return {}; } export function useSelectedLayoutSegment() { return null; }",
    '@/lib/db/client': 'export const fetchWithAuth = (u, i) => fetch(u, i); export const switchOrg = async () => ({ ok: true }); export const switchProject = async () => ({ ok: true });',
    '@/components/realtime-provider': 'export function useSseMultiplexerContext() { return { isAlive: () => false, subscribe: () => () => {}, subscribeMessage: () => () => {}, subscribeReconnect: () => () => {}, connected: true }; }',
  };
  const filter = new RegExp(`^(${Object.keys(bodies).map((k) => k.replace(/[/.-]/g, '\\$&')).join('|')})$`);
  const out = await esbuild.build({
    stdin: {
      contents: `
        import React from 'react'; import { createRoot } from 'react-dom/client'; import { NextIntlClientProvider } from 'next-intl';
        import ko from './messages/ko.json';
        import { TeamPresenceToggleProvider } from './src/components/presence/team-presence-toggle';
        import { TopBar } from './src/components/nav/top-bar';
        import { TopBarProvider } from './src/components/nav/top-bar-context';
        import { TopBarSlot } from './src/components/nav/top-bar-slot';
        import { SidebarProvider } from './src/components/ui/sidebar';
        import { ToastProvider } from './src/components/ui/toast';
        import { RoomBarTitle, RoomHead } from './src/components/chat/room-head';
        import { ChatInput } from './src/components/chat/chat-input';
        import { IconButton } from './src/components/ds/icon-button';
        import { StatusLabel } from './src/components/ds/status-label';
        import { Avatar } from './src/components/shared/avatar';
        const intl = (child) => React.createElement(NextIntlClientProvider, { locale: 'ko', messages: ko, timeZone: 'Asia/Seoul' }, child);
        const chip = (id, name, status) => ({ id, who: <><Avatar name={name} label={name} avatarUrl={null} actorType={status ? 'agent' : 'human'} size={18} className="flex-shrink-0" runtimeType={status ? 'claude-code' : null} /><span className="min-w-0 truncate">{name}</span></>, state: status ? <StatusLabel status={status} label={{ online: '연결됨', idle: '자리 비움', offline: '오프라인' }[status]} /> : undefined });
        window.__mount = (title, h) => {
          const root = createRoot(document.getElementById('root'));
          root.render(intl(
            <ToastProvider><TopBarProvider><SidebarProvider><TeamPresenceToggleProvider value={{ toggle() {}, workingCount: 4, open: false }}>
              <div id="screen" style={{ display: 'flex', flexDirection: 'column', height: h + 'px', width: '100%' }} className="bg-background text-foreground">
                <TopBar />
                <TopBarSlot
                  title={<RoomBarTitle backLabel="대화" onBack={() => {}} title={title} tag="프로젝트 방" subline="AC4 project · 3명" peopleLabel="참여자 보기" peopleCount={3} chips={[chip('m1', '지우(나)'), chip('a1', '개발 에이전트', 'online'), chip('a2', '검수 에이전트', 'idle')]} addLabel="참여자 추가" onAdd={() => {}} />}
                  actions={<IconButton icon="more_horiz" label="방 더보기" data-testid="room-head-menu" />}
                />
                <div id="col" className="flex min-h-0 flex-1 flex-col overflow-hidden">
                  {/* the page draws this in the room column as well — below lg it must be display:none (the bar in the shell row replaces it) */}
                  <RoomHead title={title} tag="프로젝트 방" subline="AC4 project · 3명" chips={[chip('m1', '지우(나)'), chip('a1', '개발 에이전트', 'online')]} addLabel="참여자 추가" onAdd={() => {}} trailing={null} />
                  <div id="timeline" className="min-h-0 flex-1 overflow-y-auto px-4 py-3">{Array.from({ length: 30 }, (_, i) => <p key={i} className="py-2 text-sm">메시지 {i} — 긴 문장이 한 줄을 넘어가도 가로로 밀리지 않아야 해요 어떤 폭에서도</p>)}</div>
                  <ChatInput threadId="c1" onSend={async () => {}} onUploadFile={async (f) => ({ url: 'u', name: f.name, content_type: f.type, size: f.size })} projectId="p1" currentTeamMemberId="me-1" participants={[{ member_id: 'a-1', name: '개발 에이전트' }]} placeholder={ko.chats.inputPlaceholderMobile} />
                </div>
                <div id="dock" style={{ height: '56px', flexShrink: 0 }} className="border-t" />
              </div>
            </TeamPresenceToggleProvider></SidebarProvider></TopBarProvider></ToastProvider>));
        };`,
      resolveDir: WEB, loader: 'tsx',
    },
    bundle: true, format: 'iife', platform: 'browser', write: false, logLevel: 'silent', jsx: 'automatic',
    tsconfig: path.join(WEB, 'tsconfig.json'),
    define: { 'process.env.NODE_ENV': '"production"', 'process.env.NEXT_PUBLIC_APP_URL': '"https://app.sprintable.ai"' },
    plugins: [
      { name: 'phone-bar-4887-stubs', setup(b) {
        b.onResolve({ filter }, (a) => ({ path: a.path, namespace: 'stub4887p' }));
        b.onResolve({ filter: /release-notes-gate$/ }, (a) => ({ path: a.path, namespace: 'stub4887p' }));
        b.onLoad({ filter: /.*/, namespace: 'stub4887p' }, (a) => ({ contents: a.path.includes('release-notes-gate') ? 'export function useReleaseNotes() { return { open() {}, hasUnseen: true }; }' : bodies[a.path]!, loader: 'js', resolveDir: WEB }));
        b.onResolve({ filter: /^\.\/(now-strip|pulse-card)$/ }, (a) => ({ path: a.path, namespace: 'strip4887p' }));
        b.onLoad({ filter: /.*/, namespace: 'strip4887p' }, (a) => ({ contents: a.path.includes('now-strip') ? 'export function NowStrip() { return null; }' : 'export function PulseCard() { return null; }', loader: 'js', resolveDir: WEB }));
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

async function open(page: Page, w: number, h: number, title: string) {
  const { js, css } = await build();
  await page.setViewportSize({ width: w, height: h });
  await page.unrouteAll();
  await page.route('http://preview.test/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head><body class="bg-background text-foreground" style="margin:0"><div id="root"></div></body></html>` });
    if (url.pathname === '/api/event-notifications/unread-count') return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ count: 7 }) });
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ data: [], meta: { hasMore: false } }) });
  });
  const thrown: string[] = [];
  page.on('pageerror', (e) => thrown.push(e.message));
  await page.addInitScript(() => { (window as unknown as { process: unknown }).process = { env: {} }; });
  await page.goto('about:blank');
  await page.goto('http://preview.test/');
  await page.addScriptTag({ content: js });
  await page.evaluate(([t, hh]) => (window as unknown as { __mount: (t: string, h: number) => void }).__mount(t as string, hh as number), [title, h] as const);
  await page.waitForTimeout(1200);
  if (await page.locator('[data-testid="room-bar"]').count() === 0) throw new Error(`the room bar was not drawn — page errors: ${thrown.join(' | ') || 'none'}`);
}

const measure = (page: Page) => page.evaluate(() => {
  const r = (s: string) => { const e = document.querySelector(s); if (!e) return null; const b = e.getBoundingClientRect(); return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height), r: Math.round(b.right) }; };
  const vis = (e: Element) => { const b = e.getBoundingClientRect(); return b.width > 0 && b.height > 0 && getComputedStyle(e).visibility !== 'hidden'; };
  const presses = [...document.querySelectorAll('[data-testid="top-bar"] button, #col button, #col textarea')].filter(vis);
  const small = presses.filter((e) => { const b = e.getBoundingClientRect(); return e.tagName !== 'TEXTAREA' && (b.width < 43.5 || b.height < 43.5); }).map((e) => `${(e.getAttribute('aria-label') || e.textContent || e.tagName).trim().slice(0, 20)} ${Math.round(e.getBoundingClientRect().width)}×${Math.round(e.getBoundingClientRect().height)}`);
  const ta = document.querySelector('#col textarea') as HTMLTextAreaElement;
  return {
    topBar: r('[data-testid="top-bar"]'), bar: r('[data-testid="room-bar"]'), timeline: r('#timeline'), composerBox: r('[data-testid="chat-composer-box"]'), composerRegion: r('#col > div:last-child'),
    h1: [...document.querySelectorAll('h1')].filter(vis).length, h1Text: [...document.querySelectorAll('h1')].find(vis)?.textContent, // the VISIBLE h1s: the page never renders the in-column head below lg, and this scene keeps it only to prove it is display:none
    bell: r('[data-testid="top-bar"] button[aria-label*="알림"]'), more: r('[data-testid="room-head-menu"]'),
    roomHeadDisplay: (() => { const e = document.querySelector('[data-testid="room-head"]'); return e ? getComputedStyle(e).display : null; })(), taW: ta ? Math.round(ta.clientWidth) : null, small, overflowX: document.documentElement.scrollWidth > innerWidth + 1, screenH: innerHeight,
  };
});

test.describe('the room head on a touch phone', () => {
  test.use({ hasTouch: true, isMobile: true });

  for (const [w, h] of [[390, 844], [320, 640]] as const) {
    test(`[SID:4887] ${w} × ${h}: the top is the shell row alone (48), the room bar fits with the bell, nothing runs past the screen, every press ≥ 44`, async ({ page }) => {
      await open(page, w, h, '결제 연동 · 오늘 할 일 점검 — 아주 긴 방 이름이 이어져요');
      const m = await measure(page);
      console.log(`phone ${w}x${h}`, JSON.stringify({ top: m.topBar?.h, timeline: m.timeline, composerBox: m.composerBox?.h, composerRegion: m.composerRegion?.h, taW: m.taW }));
      expect(m.topBar!.h, 'the shell row is 48 px — the room bar is INSIDE it, not a block under it').toBe(48);
      expect(m.timeline!.y, 'the timeline starts right under the shell row').toBe(48); // reverted (a head block under the row) → 183
      expect(m.bar!.y >= 0 && m.bar!.y + m.bar!.h <= 48, 'the room bar is inside the shell row').toBe(true);
      expect(m.roomHeadDisplay, 'the in-column head is not drawn on a phone (it would be a second head under the shell row)').toBe('none'); // reverted (no max-lg:hidden) → flex: 135 px of reading column back
      expect(m.h1, 'one h1 (the hidden head\'s h1 is not in the tree)').toBe(1);
      expect(m.bell && m.bell.r <= w, 'the bell is still on the screen').toBeTruthy();
      expect(m.more && m.more.r <= w, 'the «⋯» is on the screen').toBeTruthy();
      expect(m.overflowX, 'nothing runs past the screen sideways').toBe(false);
      expect(m.small, `presses under 44 px: ${m.small.join(' · ')}`).toEqual([]);
      expect(m.composerRegion!.h, `the composer is one line of text even at ${w} (the hint is cut with an ellipsis, never wrapped): region ${m.composerRegion!.h}px`).toBeLessThanOrEqual(104);
    });
  }

  test('[SID:4887] 390 × 844: the reading column is at least what it was before 5612 (635), the composer region is not taller than it was (104)', async ({ page }) => {
    await open(page, 390, 844, '시스템 발행');
    const m = await measure(page);
    expect(m.timeline!.h, `the reading column is ${m.timeline!.h}px (before 5612: 635 · on dev after 5612: 482)`).toBeGreaterThanOrEqual(635);
    expect(m.composerRegion!.h, `the composer region is ${m.composerRegion!.h}px (before 5612: 104)`).toBeLessThanOrEqual(104);
  });

  test('[SID:4887] the people button opens the participants and the «+» on the screen; Escape closes it and the focus returns to the button', async ({ page }) => {
    await open(page, 390, 844, '시스템 발행');
    const people = page.locator('[data-testid="room-bar-people"]');
    expect((await people.boundingBox())!.height, 'the people button is a 44 px press').toBeGreaterThanOrEqual(43.5);
    await people.tap();
    const popup = page.locator('[data-testid="room-bar-people-popup"]');
    await expect(popup).toBeVisible();
    expect(await popup.locator('[data-testid="room-head-chip"]').count()).toBe(3);
    await expect(popup.locator('[data-testid="room-head-add"]')).toBeVisible();
    const b = (await popup.boundingBox())!;
    expect(b.x >= 0 && b.x + b.width <= 390, `the popup is on the screen (x ${Math.round(b.x)}..${Math.round(b.x + b.width)})`).toBe(true);
    await page.keyboard.press('Escape');
    await expect(popup).toHaveCount(0);
    expect(await page.evaluate(() => (document.activeElement as HTMLElement | null)?.getAttribute('data-testid'))).toBe('room-bar-people');
  });
});
