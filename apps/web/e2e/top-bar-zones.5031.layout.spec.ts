/**
 * story 5031 (C1 step 5a · PO 11-27) — the desktop top bar's three zones, measured in Chromium with the REAL TopBar (bundled with esbuild, not copied) and the real Tailwind build of globals.css; no server.
 * From lg the bar is 64 high (its bottom border inside) and reads: LEFT the path (org › project-or-place › title) · MIDDLE a 40 high field that opens ⌘K · RIGHT the buttons. At 1440 / 1280 / 1100: no overflow, every box inside the bar, a very long project / room name
 * is cut with «…» and does NOT push the field or the buttons out, the field is ≤ 480 wide and sits between the zones (centred when the sides are equal). Below lg (390) the bar is the phone's: 48 high, no path, no field.
 * Inside the desktop app (`window.sprintableDesktop` — the app's bridge) the strip computes `-webkit-app-region: drag` and EVERY pressable inside it `no-drag`; in a browser none of that. A browser cannot drag a window: this measures the computed region, not the OS.
 * The shell around the bar is not rebuilt here (shell-chrome-bands.4913 does that); the bar sits in a box as wide as the shell leaves it: the window − the 56 icon bar − the 256 list column − the 2 × 8 inset.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { expect, test, type Page } from '@playwright/test';
import { compile, optimize } from '@tailwindcss/node';
import type { Plugin } from 'esbuild';
import { layoutStubPlugin } from './support/layout-stubs';
import { tailwindCandidates } from './support/tailwind-candidates';

const req = createRequire(__filename);
const WEB = path.join(__dirname, '..');
const APP = path.join(WEB, 'src', 'app');

// the router answers the stubs cannot: the path the harness sets (`window.__pathname`)
const ROUTER_STUB = `
  export function usePathname() { return window.__pathname || '/org-briefing'; }
  export function useRouter() { return { push() {}, replace() {}, back() {}, refresh() {}, prefetch() {} }; }
  export function useSearchParams() { return new URLSearchParams(''); }
  export function useParams() { return {}; }`;
function routerPlugin(): Plugin {
  return { name: 'router-5031', setup(b) {
    b.onResolve({ filter: /^next\/navigation$/ }, (a) => ({ path: a.path, namespace: 'router5031' }));
    b.onLoad({ filter: /.*/, namespace: 'router5031' }, () => ({ contents: ROUTER_STUB, loader: 'js', resolveDir: WEB }));
  } };
}

let built: { js: string; css: string } | null = null;
async function build() {
  if (built) return built;
  const esbuild = req('esbuild') as typeof import('esbuild');
  const out = await esbuild.build({
    stdin: {
      contents: `
        import React from 'react'; import { createRoot } from 'react-dom/client'; import { NextIntlClientProvider } from 'next-intl';
        import ko from './messages/ko.json';
        import { TopBar } from './src/components/nav/top-bar';
        import { TopBarProvider } from './src/components/nav/top-bar-context';
        import { TopBarSlot } from './src/components/nav/top-bar-slot';
        import { SidebarProvider } from './src/components/ui/sidebar';
        import { BAR_HIDDEN_ON_PHONE_CLASS } from './src/lib/top-bar-phone';
        import { ToastProvider } from './src/components/ui/toast';
        import { TeamPresenceToggleProvider } from './src/components/presence/team-presence-toggle';
        import { CommandPaletteProvider } from './src/components/command-palette/command-palette-context';
        window.__mount = (cfg) => {
          window.__pathname = cfg.pathname;
          const title = cfg.titleKind === 'none' ? null : cfg.titleKind === 'empty-component' ? React.createElement(function Empty() { return null; }) : cfg.titleKind === 'h1' ? <h1 className="text-sm font-medium">{cfg.title}</h1> : <span className="text-sm font-medium">{cfg.title}</span>;
          createRoot(document.getElementById('root')).render(
            <NextIntlClientProvider locale="ko" messages={ko} timeZone="Asia/Seoul">
              <ToastProvider><CommandPaletteProvider><TopBarProvider><SidebarProvider><TeamPresenceToggleProvider value={{ toggle() {}, workingCount: 3, open: false }}>
                <div id="frame" style={{ width: cfg.frameWidth + 'px' }} className="flex flex-col">
                  <TopBar className={cfg.hiddenOnPhone ? BAR_HIDDEN_ON_PHONE_CLASS : undefined} orgId="o1" orgMemberships={[{ orgId: 'o1', orgName: cfg.org, orgSlug: 'acme' }]} projectId="p1" projectMemberships={[{ projectId: 'p1', projectName: cfg.project }]} />
                  <TopBarSlot title={title} actions={cfg.withActions ? <><button type="button" id="action-btn" className="rounded-ds-control border px-3">액션</button><div id="odd-action" style={{ cursor: 'pointer' }} className="px-2" onClick={() => {}}>기타</div></> : null} />
                </div>
              </TeamPresenceToggleProvider></SidebarProvider></TopBarProvider></CommandPaletteProvider></ToastProvider>
            </NextIntlClientProvider>);
        };`,
      resolveDir: WEB, loader: 'tsx',
    },
    bundle: true, format: 'iife', platform: 'browser', write: false, logLevel: 'silent', jsx: 'automatic',
    tsconfig: path.join(WEB, 'tsconfig.json'),
    define: { 'process.env.NODE_ENV': '"production"', 'process.env.NEXT_PUBLIC_APP_URL': '"https://app.sprintable.ai"' },
    plugins: [routerPlugin(), layoutStubPlugin()],
  });
  const js = out.outputFiles[0]!.text;
  // the stylesheet adds what the page itself holds: the drag rules and the real tokens live in globals.css
  const compiler = await compile(readFileSync(path.join(APP, 'globals.css'), 'utf8'), { base: APP, onDependency: () => {} });
  const css = (optimize as unknown as (c: string, o?: object) => { code: string })(compiler.build(tailwindCandidates(js)), { minify: false }).code;
  built = { js, css };
  return built;
}

type Cfg = { pathname: string; titleKind: 'h1' | 'span' | 'none' | 'empty-component'; title?: string; org: string; project: string; frameWidth: number; withActions?: boolean; hiddenOnPhone?: boolean };
const SHORT = { org: '올리베이라', project: '스프린터블' };
const LONG = { org: '아주아주아주아주아주아주아주아주 긴 조직 이름 주식회사 문클랩스 코리아 서비스', project: '아주아주아주아주아주아주아주아주아주아주아주아주 긴 프로젝트 이름 — 결제 연동과 정산 자동화와 고객 문의 분류' };
/** the width the shell leaves the bar at a window width: the window − 56 icon bar − 256 list column − 16 inset margins (≥ lg) */
const barWidth = (win: number) => win - 56 - 256 - 16;

async function open(page: Page, cfg: Cfg, o: { win: number; desktopApp?: boolean }) {
  const { js, css } = await build();
  await page.setViewportSize({ width: o.win, height: 700 });
  await page.unrouteAll();
  await page.route('http://preview.test/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head><body style="margin:0"><div id="root"></div></body></html>` });
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ data: [] }) });
  });
  if (o.desktopApp) {
    await page.addInitScript(() => {
      (window as unknown as { sprintableDesktop: unknown }).sprintableDesktop = Object.freeze({ inApp: true, device: { name: 'Mac' }, runtimes: [], pickFolder: async () => null, startHere: async () => ({ ok: true }), setProjectFolder: async () => ({ ok: true }) });
    });
  }
  const errs: string[] = [];
  page.on('pageerror', (e) => errs.push(String(e).slice(0, 300)));
  await page.goto('about:blank');
  await page.goto('http://preview.test/');
  await page.addScriptTag({ content: js });
  if (!(await page.evaluate(() => typeof (window as unknown as { __mount?: unknown }).__mount === 'function'))) throw new Error(`the bundle did not start: ${errs.join(' | ')}`);
  await page.evaluate((c) => (window as unknown as { __mount: (c: unknown) => void }).__mount(c), cfg);
  try { await page.waitForSelector('[data-testid="top-bar"] button[aria-label^="알림"]', { state: 'attached', timeout: 8000 }); } catch (e) {
    throw new Error(`the bar did not draw (page errors: ${errs.join(' | ') || 'none'}; body: ${(await page.evaluate(() => document.body.innerHTML)).slice(0, 600)})`, { cause: e });
  }
  await page.evaluate(() => document.fonts.ready);
  expect(errs, 'the page threw').toEqual([]);
}

const measure = (page: Page) => page.evaluate(() => {
  const q = (s: string) => document.querySelector(s) as HTMLElement | null;
  const box = (el: Element | null) => { if (!el) return null; const r = el.getBoundingClientRect(); return { l: r.left, t: r.top, r: r.right, b: r.bottom, w: r.width, h: r.height }; };
  const bar = q('[data-testid="top-bar"]')!;
  const bb = bar.getBoundingClientRect();
  const visible = (el: Element) => { const cs = getComputedStyle(el); const r = el.getBoundingClientRect(); return cs.display !== 'none' && cs.visibility !== 'hidden' && r.width > 0 && r.height > 0; };
  const outside = [...bar.querySelectorAll('*')].filter((el) => visible(el) && !(el.closest('svg') && el.tagName !== 'svg')).filter((el) => { const r = el.getBoundingClientRect(); return r.left < bb.left - 0.5 || r.right > bb.right + 0.5 || r.top < bb.top - 0.5 || r.bottom > bb.bottom + 0.5; }).map((el) => `${el.tagName.toLowerCase()}[${el.getAttribute('data-testid') ?? el.getAttribute('aria-label') ?? el.className.toString().slice(0, 30)}]`);
  const field = q('[data-testid="top-bar-search-field"]');
  const title = q('[data-testid="top-bar-title"]');
  return {
    bar: box(bar), barScrollW: bar.scrollWidth, barClientW: bar.clientWidth, barOffsetH: bar.offsetHeight,
    left: box(q('[data-testid="top-bar-left"]')), center: box(q('[data-testid="top-bar-center"]')), right: box(q('[data-testid="top-bar-right"]')),
    path: box(q('[data-testid="top-bar-path"]')), pathDisplay: q('[data-testid="top-bar-path"]') ? getComputedStyle(q('[data-testid="top-bar-path"]')!).display : null,
    crumbDisplays: [...document.querySelectorAll('[data-testid="top-bar-path"] li[data-crumb]')].map((c) => getComputedStyle(c).display),
    centerDisplay: q('[data-testid="top-bar-center"]') ? getComputedStyle(q('[data-testid="top-bar-center"]')!).display : null,
    field: box(field), fieldRadius: field ? getComputedStyle(field).borderTopLeftRadius : null, fieldBorder: field ? getComputedStyle(field).borderTopWidth : null,
    fieldPad: field ? [getComputedStyle(field).paddingLeft, getComputedStyle(field).paddingRight] : null, fieldFont: field ? [getComputedStyle(field).fontSize, getComputedStyle(field).fontWeight] : null,
    fieldIcon: field ? box(field.querySelector('svg')) : null, fieldText: field ? box(field.querySelector('span')) : null, fieldHint: field ? box(field.querySelector('kbd')) : null,
    phoneIcon: box(q('[data-testid="top-bar-search"]')), bell: box(q('button[aria-label^="알림"]')),
    title: box(title), titleBefore: title ? getComputedStyle(title, '::before').content : null,
    outside,
  };
});

const DESKTOP = [1440, 1280, 1100] as const;

for (const win of DESKTOP) {
  const frameWidth = barWidth(win);
  test(`[SID:5031] ${win}: the bar is 64 high, three zones, no overflow, the field is 40 high · ≤ 480 wide · between the zones`, async ({ page }) => {
    await open(page, { pathname: '/acme/sprintable/flow', titleKind: 'h1', title: '흐름', ...SHORT, frameWidth, withActions: true }, { win });
    const m = await measure(page);
    console.log(`[5031 numbers] win ${win} bar ${m.bar!.w}×${m.bar!.h} · left ${Math.round(m.left!.w)} · field x ${Math.round(m.field!.l - m.bar!.l)} w ${Math.round(m.field!.w)} h ${m.field!.h} · field centre offset from bar centre ${Math.round(((m.field!.l + m.field!.r) / 2) - ((m.bar!.l + m.bar!.r) / 2))} · right ${Math.round(m.right!.w)} · overflow ${m.barScrollW - m.barClientW}`);
    expect(m.barOffsetH, 'the bar is 64 high (the bottom border is inside)').toBe(64);
    expect(m.barScrollW - m.barClientW, 'the bar does not overflow sideways').toBe(0);
    expect(m.outside, 'every box is inside the bar').toEqual([]);
    expect(m.field!.h, 'the field is 40 high').toBe(40);
    expect(m.field!.w).toBeLessThanOrEqual(480);
    if (win === 1440) expect(m.field!.w, 'the room allows the full 480').toBe(480);
    expect(m.fieldRadius).toBe('8px');
    expect(m.fieldBorder).toBe('1px');
    expect(m.fieldPad).toEqual(['12px', '16px']);
    expect(m.fieldFont).toEqual(['16px', '400']);
    expect(Math.round(m.fieldIcon!.w), 'icon 24').toBe(24);
    expect(Math.round(m.fieldText!.l - m.fieldIcon!.r), '12 between the icon and the text').toBe(12);
    expect(m.fieldHint, 'the ⌘K / Ctrl K hint is drawn').not.toBeNull();
    expect(m.fieldHint!.r, 'the hint ends before the 16 right padding').toBeLessThanOrEqual(m.field!.r - 16 + 0.5);
    // the three zones in a row, no overlap; the field sits between them, vertically centred in the bar
    expect(m.left!.r).toBeLessThanOrEqual(m.center!.l + 0.5);
    expect(m.center!.r).toBeLessThanOrEqual(m.right!.l + 0.5);
    expect(Math.abs((m.field!.t + m.field!.b) / 2 - (m.bar!.t + m.bar!.b) / 2), 'the field is centred vertically (the border is the bar\'s last pixel)').toBeLessThanOrEqual(1);
    // centred in the bar when the two sides have the room (1440 · 1280); at 1100 the right zone may be wider than its share: between the zones is enough
    if (win >= 1280) expect(Math.abs(((m.field!.l + m.field!.r) / 2) - ((m.bar!.l + m.bar!.r) / 2)), 'the field is centred in the bar').toBeLessThanOrEqual(1);
    expect(m.phoneIcon?.w ?? 0, 'the phone icon is not drawn from lg (its wrapper is display: none)').toBe(0);
  });

  test(`[SID:5031] ${win}: a very long organisation · project · room name is cut with an ellipsis and does NOT push the field or the buttons out`, async ({ page }) => {
    await open(page, { pathname: '/acme/sprintable/flow', titleKind: 'span', title: '흐름', ...SHORT, frameWidth, withActions: true }, { win });
    const short = await measure(page);
    await open(page, { pathname: '/acme/sprintable/flow', titleKind: 'span', title: '아주아주아주아주 긴 방 이름 — 결제 연동 · 오늘 할 일 · 정산 자동화 · 고객 문의 분류 · 주간 회의록 정리와 공유', ...LONG, frameWidth, withActions: true }, { win });
    const long = await measure(page);
    expect(long.barScrollW - long.barClientW).toBe(0);
    expect(long.outside).toEqual([]);
    // the field and the buttons are exactly where the short names left them
    expect(Math.round(long.field!.l), 'field x').toBe(Math.round(short.field!.l));
    expect(Math.round(long.field!.w), 'field width').toBe(Math.round(short.field!.w));
    expect(Math.round(long.right!.l), 'right zone x').toBe(Math.round(short.right!.l));
    expect(Math.round(long.bell!.r), 'bell x').toBe(Math.round(short.bell!.r));
    expect(long.left!.r, 'the left zone stays left of the field').toBeLessThanOrEqual(long.center!.l + 0.5);
    expect(long.barOffsetH).toBe(64);
    // the long text really is cut (an ellipsis box), not hidden by an overflow of the bar
    const cut = await page.evaluate(() => [...document.querySelectorAll('[data-testid="top-bar-path"] li > *, [data-testid="top-bar-title"] > *')].some((el) => el.scrollWidth > el.clientWidth));
    expect(cut, 'at least one crumb is cut with an ellipsis').toBe(true);
  });
}

test('[SID:5031] a title component that draws nothing — or no publisher at all (a settings sub-screen) — leaves no dangling separator and no blank item; a title that draws something has a separator before it (real stylesheet)', async ({ page }) => {
  await open(page, { pathname: '/chats', titleKind: 'empty-component', ...SHORT, frameWidth: barWidth(1280) }, { win: 1280 });
  expect((await measure(page)).titleBefore, 'nothing after the last crumb: no «›»').toMatch(/^(none|normal)$/);
  await open(page, { pathname: '/settings/integrations', titleKind: 'none', ...SHORT, frameWidth: barWidth(1280) }, { win: 1280 });
  const none = await page.evaluate(() => { const li = document.querySelector('[data-testid="top-bar-title"]') as HTMLElement; return { display: getComputedStyle(li).display, before: getComputedStyle(li, '::before').content, crumbs: [...document.querySelectorAll('[data-testid="top-bar-path"] li[data-crumb]')].map((c) => c.textContent) }; });
  expect(none.crumbs, 'a settings sub-screen with no title publisher: the path ends at the place').toEqual(['올리베이라', '설정']);
  expect(none.display, 'the empty title item is not drawn from lg (no blank list item)').toBe('none');
  await open(page, { pathname: '/chats/room-1', titleKind: 'span', title: '민 · 디디', ...SHORT, frameWidth: barWidth(1280) }, { win: 1280 });
  expect((await measure(page)).titleBefore).toBe('"›"');
});

test('[SID:5031] 390 (below lg): the bar is the phone\'s — 48 high, no path, no field, the search ICON is drawn, no overflow', async ({ page }) => {
  await open(page, { pathname: '/inbox', titleKind: 'h1', title: '결재함', ...SHORT, frameWidth: 390 }, { win: 390 });
  const m = await measure(page);
  console.log(`[5031 numbers] win 390 bar ${m.bar!.w}×${m.bar!.h} · phone icon ${m.phoneIcon ? 'drawn' : 'none'}`);
  expect(m.barOffsetH).toBe(48);
  expect(m.pathDisplay, 'the nav is display: contents below lg (the title item is the bar\'s own item)').toBe('contents');
  expect(m.crumbDisplays.length).toBeGreaterThan(0);
  expect(m.crumbDisplays.every((d) => d === 'none'), 'the leading crumbs are not drawn below lg').toBe(true);
  expect(m.centerDisplay).toBe('none');
  expect(m.phoneIcon).not.toBeNull();
  expect(m.barScrollW - m.barClientW).toBe(0);
  expect(m.outside).toEqual([]);
});

test('[SID:5031] desktop app: the strip computes `-webkit-app-region: drag` and EVERY pressable inside it `no-drag`; in a browser nothing is marked', async ({ page }) => {
  const region = () => page.evaluate(() => {
    const bar = document.querySelector('[data-testid="top-bar"]') as HTMLElement;
    const get = (el: Element) => getComputedStyle(el).getPropertyValue('-webkit-app-region').trim();
    // the SAME set the stylesheet's rule names (globals.css `[data-desktop-app] :where(…)`)
    const pressables = [...bar.querySelectorAll('a, button, input, select, textarea, summary, label, [role="button"], [role="link"], [role="menuitem"], [role="switch"], [role="tab"], [role="combobox"], [contenteditable], [tabindex]:not([tabindex="-1"])')].filter((el) => getComputedStyle(el).display !== 'none');
    const group = document.querySelector('[data-testid="top-bar-buttons"]') as HTMLElement;
    const odd = document.getElementById('odd-action')!.getBoundingClientRect();
    const g = group.getBoundingClientRect();
    const outer = document.querySelector('[data-testid="top-bar-right"]') as HTMLElement;
    return { bar: get(bar), marked: bar.hasAttribute('data-desktop-app'), group: get(group), outerRight: get(outer), oddInsideGroup: odd.left >= g.left - 0.5 && odd.right <= g.right + 0.5 && odd.top >= g.top - 0.5 && odd.bottom <= g.bottom + 0.5, left: get(document.querySelector('[data-testid="top-bar-left"]')!), pressables: pressables.map((el) => `${el.tagName.toLowerCase()}:${el.getAttribute('data-testid') ?? el.getAttribute('aria-label') ?? el.textContent!.slice(0, 12)}=${get(el)}`) };
  });
  const cfg: Cfg = { pathname: '/organization/workforce/runs', titleKind: 'span', title: '실행 기록', ...SHORT, frameWidth: barWidth(1280), withActions: true };
  await open(page, cfg, { win: 1280 });
  const browser = await region();
  expect(browser.marked, 'a browser does not mark the strip').toBe(false);
  expect(browser.bar === '' || browser.bar === 'none', `a browser strip has no region (got «${browser.bar}»)`).toBe(true);
  await open(page, cfg, { win: 1280, desktopApp: true });
  const app = await region();
  console.log(`[5031 drag] ${JSON.stringify(app)}`);
  expect(app.marked).toBe(true);
  expect(app.bar, 'the strip drags').toBe('drag');
  expect(app.left, 'the path text inherits… the region is a property of the strip: its non-pressable parts drag too').not.toBe('no-drag');
  // search field · the two crumb links · the action button · the people button · what's-new · the bell are all there and all no-drag
  expect(app.group, 'the buttons\' group (page actions · popover controls · the bell) is no-drag as a whole').toBe('no-drag');
  expect(app.oddInsideGroup, 'a control no selector knows (a clickable div in the actions) lies inside that group').toBe(true);
  expect(app.outerRight, 'the empty room around the group still drags (the outer zone is not no-drag)').not.toBe('no-drag');
  expect(app.pressables.length, 'search + 2 crumb links + action + presence + what\'s new + bell').toBeGreaterThanOrEqual(7);
  expect(app.pressables.filter((p) => !p.endsWith('=no-drag')), 'every pressable inside the strip is no-drag').toEqual([]);
});

// story 5031 (5a follow-up · PO): a PHONE's settings keeps no bar. The shell mounts the bar with this class until the width is known; below lg it is display: none (0 high), from lg (1024) it is the full 64 bar with its three zones.
for (const [win, high] of [[390, 0], [1023, 0], [1024, 64], [1100, 64], [1440, 64]] as const) {
  test(`[SID:5031] settings' bar class at ${win}: ${high === 0 ? 'no bar (display: none)' : 'the 64 bar'}`, async ({ page }) => {
    await open(page, { pathname: '/settings', titleKind: 'span', title: '프로필', ...SHORT, frameWidth: win < 1024 ? win : barWidth(win), hiddenOnPhone: true }, { win });
    const m = await page.evaluate(() => { const b = document.querySelector('[data-testid="top-bar"]') as HTMLElement; return { h: b.getBoundingClientRect().height, display: getComputedStyle(b).display }; });
    console.log(`[5031 settings bar] win ${win} → ${m.display} ${m.h}`);
    expect(m.h).toBe(high);
    expect(m.display === 'none').toBe(high === 0);
  });
}
