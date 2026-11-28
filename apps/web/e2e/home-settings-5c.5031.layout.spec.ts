/**
 * story 5031 (C1 step 5c · PO 11-27) — the home's two columns and the settings' one list, measured in Chromium with the REAL components (bundled with esbuild) and the real Tailwind build, inside the shell's own class chain (the provider · the sidebar peer · the inset · the scroller · the content cell — read from the sources).
 *  HOME (≥ 1024): the body fills the inset (no centred 896 column), the DETAIL is a fixed 340 and the list takes the rest; below 1024 the detail is a sheet (no column). `ListDetailShell`'s DEFAULT split is unchanged (the agents frame and the inbox tabs keep it).
 *  SETTINGS (≥ 1024): the shell's list column is folded (the screen has its own navigation), the navigation column is 256, its rows are 40 high; on a phone the list is as before (rows 56).
 * What the JS decides — «which screen folds the shell's list column» and «the home passes `fixed`» — is pinned from the sources here and by nav-active.test.ts.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { expect, test, type Page } from '@playwright/test';
import { compile, optimize } from '@tailwindcss/node';
import { layoutStubPlugin } from './support/layout-stubs';
import { HOME_DETAIL_W, HOME_GAP, HOME_LIST_MIN, HOME_TWO_COLUMN_MIN } from '../src/components/home/home-layout';
import { tailwindCandidates } from './support/tailwind-candidates';
import { pick, read, shellClasses } from './support/shell-scene';

const req = createRequire(__filename);
const WEB = path.join(__dirname, '..');
const SRC = path.join(WEB, 'src');
const APP = path.join(SRC, 'app');

/** the home's body root (org-briefing-shell.tsx) and what the home hands the shell (home-screen.tsx) — read from the sources, so a change there is what is measured */
function homeSources() {
  return {
    root: pick(read('components/org-briefing/org-briefing-shell.tsx'), /<div className="([^"]*)">\s*\{\/\* story 4773 \(AC3/, 'org-briefing-shell.tsx: the body root'),
    detailWidth: (/detailWidth="(\w+)"/.exec(read('components/home/home-screen.tsx'))?.[1] ?? 'flex') as 'flex' | 'fixed',
  };
}
/** the settings page's navigation column / pane / tabs root class strings (page.tsx), with the template's `lnbOpen` branches resolved for the pane being shown (lg) or the list being the screen (phone) */
function settingsSources(lnbOpen: boolean) {
  const page = read('app/(authenticated)/settings/page.tsx');
  const col = pick(page, /<div className=\{`(focus-inset shrink-0 overflow-y-auto border-ds-line[^`]*)`\} data-testid="settings-nav-column"/, 'settings/page.tsx: the navigation column').replace("${lnbOpen ? 'flex w-full flex-col' : 'hidden'}", lnbOpen ? 'flex w-full flex-col' : 'hidden');
  const pane = pick(page, /<div className=\{`(focus-inset min-w-0 flex-1 overflow-y-auto[^`]*)`\} data-testid="settings-pane"/, 'settings/page.tsx: the pane').replace("${lnbOpen ? 'hidden lg:block' : ''}", lnbOpen ? 'hidden lg:block' : '');
  const tabs = pick(page, /<Tabs value=\{activeTab\} onValueChange=\{handleTabChange\} orientation="vertical" className="([^"]+)"/, 'settings/page.tsx: the tabs root');
  return { col, pane, tabs };
}

let built: { js: string; css: string } | null = null;
async function build() {
  if (built) return built;
  const esbuild = req('esbuild') as typeof import('esbuild');
  const out = await esbuild.build({
    stdin: {
      contents: `
        import React from 'react'; import { createRoot } from 'react-dom/client'; import { NextIntlClientProvider } from 'next-intl';
        import { Tabs } from './src/components/ui/tabs';
        import { Tabs as TabsPrimitive } from '@base-ui/react/tabs';
        import ko from './messages/ko.json';
        import { ListDetailShell } from './src/components/ds/list-detail-shell';
        import { useDetailBesideList } from './src/hooks/use-detail-beside-list';
        import { HOME_TWO_COLUMN_MIN } from './src/components/home/home-layout';
        import { HomeScreen } from './src/components/home/home-screen';
        import { ToastProvider } from './src/components/ui/toast';
        import { deriveHome } from './src/components/home/derive-home';
        import { SettingsNav } from './src/app/(authenticated)/settings/settings-nav-list';
        import { settingsNavGroups } from './src/app/(authenticated)/settings/settings-nav';
        // codex 5c: the settings list with its loading skeleton rows drawn too (admin not checked yet → the organization / people groups hold placeholder rows)
        const groups = settingsNavGroups({ adminChecked: false, isAdmin: true, inPhoneApp: false, supportWidget: true, billing: true });
        // the REAL home screen with the longest names a person can have: a 40-letter Korean name with no space, a 60-letter Latin one, long titles and reasons — in the 340 detail column and in the list rows
        const LONG_KO = '가'.repeat(40), LONG_EN = 'Abcdefghij'.repeat(6), LONG_TITLE = '결제수단을바꾸는일'.repeat(9), LONG_TITLE_EN = 'ReallyLongWorkItemTitleWithoutAnySpaces'.repeat(2);
        const need = (over) => ({ id: 'g1', source: 'gate', state: 'approval', risk: 'low', workItemType: 'story', workItemId: 's1', workItemTitle: LONG_TITLE, requestedByName: LONG_KO, reason: LONG_TITLE_EN, createdAt: '2026-11-11T09:00:00Z', conversationId: 'c1', conversationProjectId: null, recipePublish: false, projectId: null, ...over });
        const realSnapshot = { needsMe: [need({}), need({ id: 'g2', state: 'signature', risk: 'high', requestedByName: LONG_EN, workItemTitle: LONG_TITLE_EN, reason: LONG_TITLE, createdAt: '2026-11-11T10:00:00Z' })], needsMeCount: 2, agentProgress: [{ runId: 'r1', agentName: LONG_EN, workItemTitle: LONG_TITLE, status: 'running', startedAt: '2026-11-11T10:30:00Z', cancel: null }] };
        const realModel = deriveHome({ snapshot: realSnapshot, notifications: [], stories: [], completedToday: [], viewerMemberId: null });
        const realSources = { snapshot: realSnapshot, notificationHrefById: {}, runConversationById: {} };
        // the home's width rule, as the home screen has it: a wrapper that measures the body (ref) + the real hook + the real constants — the wrapper / hook / constant use in home-screen.tsx is pinned from its source below
        function HomeScene({ cfg }) {
          const { ref, wide } = useDetailBesideList(HOME_TWO_COLUMN_MIN);
          return (
            <div ref={ref} id="probe">
              <ListDetailShell testId="home-screen" columnTestId="home-detail-column" sheetTestId="home-detail-sheet" wide={wide} detailWidth={cfg.home.detailWidth === 'fixed' ? 'fixed' : undefined}
                list={<div id="list" className="min-w-0 rounded-ds-control border border-ds-line p-4" style={{ height: '320px' }}>list</div>}
                detail={<div id="detail" className="rounded-ds-control border border-ds-line p-4" style={{ height: '320px' }}>detail</div>}
                detailLabel="요청" sheetLabel="자세히" sheetOpen={false} onSheetOpenChange={() => {}} />
            </div>);
        }
        const Shell = ({ cfg, children }) => (
          <div className={cfg.shell.wrapper} style={{ '--sidebar-width': '16rem' }}>
            {/* the icon bar (nav-rail: w-14 = 56) stands left of the list column in the real shell */}
            <div id="rail" className="hidden w-14 shrink-0 lg:block" />
            <div className={cfg.shell.peer} data-state={cfg.listColumnOpen ? 'expanded' : 'collapsed'} data-collapsible={cfg.listColumnOpen ? '' : 'offcanvas'} data-variant="inset" data-side="left" id="peer"><div data-slot="sidebar-gap" className={cfg.shell.gap} id="peer-gap" /></div>
            <main id="inset" className={cfg.shell.inset}><div id="scroller" className={cfg.shell.scroller}><div className={cfg.shell.grid}><div id="cell" className={cfg.shell.content}>{children}</div></div></div></main>
          </div>);
        window.__mount = (cfg) => {
          const body = cfg.screen === 'home'
            ? (<div id="home-root" className={cfg.home.root}><HomeScene cfg={cfg} /></div>)
            : cfg.screen === 'home-real'
            ? (<div id="home-root" className={cfg.home.root}><ToastProvider><HomeScreen model={realModel} sources={realSources} /></ToastProvider></div>)
            : cfg.screen === 'default-shell'
            ? (<div id="home-root" className="w-full p-6">
                <ListDetailShell testId="plain" wide={cfg.wide} list={<div id="list" className="min-w-0 border p-4" style={{ height: '200px' }}>list</div>} detail={<div id="detail" className="border p-4" style={{ height: '200px' }}>detail</div>}
                  detailLabel="상세" sheetLabel="자세히" sheetOpen={false} onSheetOpenChange={() => {}} fill={cfg.fill} />
              </div>)
            : (<Tabs value="profile" orientation="vertical" className={cfg.settings.tabs}>
                <div className={cfg.settings.col} data-testid="settings-nav-column"><h1 className="px-4 pb-2 pt-4 text-ds-title font-semibold text-ds-ink">설정</h1>
                  <SettingsNav groups={groups} activeTab="profile" integrationsHref="/settings/integrations" hrefFor={(id) => '/go/' + id} /></div>
                <div className={cfg.settings.pane} data-testid="settings-pane"><div className="mx-auto w-full max-w-3xl p-4 lg:p-6" id="pane-body"><div style={{ height: '600px' }}>본문</div></div></div>
              </Tabs>);
          createRoot(document.getElementById('root')).render(<NextIntlClientProvider locale="ko" messages={ko} timeZone="Asia/Seoul"><Shell cfg={cfg}>{body}</Shell></NextIntlClientProvider>);
        };`,
      resolveDir: WEB, loader: 'tsx',
    },
    bundle: true, format: 'iife', platform: 'browser', write: false, logLevel: 'silent', jsx: 'automatic',
    tsconfig: path.join(WEB, 'tsconfig.json'),
    define: { 'process.env.NODE_ENV': '"production"', 'process.env.NEXT_PUBLIC_APP_URL': '"https://app.sprintable.ai"' },
    plugins: [layoutStubPlugin()],
  });
  const js = out.outputFiles[0]!.text;
  // the class strings read from the sources are not in the bundle: add them to the candidates (the real Tailwind scan reads them from the source files)
  const extra = [...Object.values(shellClasses()), homeSources().root, ...['true', 'false'].flatMap((b) => Object.values(settingsSources(b === 'true')))].join(' ').split(/\s+/).filter(Boolean);
  const compiler = await compile(readFileSync(path.join(APP, 'globals.css'), 'utf8'), { base: APP, onDependency: () => {} });
  const css = (optimize as unknown as (c: string, o?: object) => { code: string })(compiler.build([...tailwindCandidates(js), ...extra]), { minify: false }).code;
  built = { js, css };
  return built;
}

// the first test used to pay for the esbuild bundle + the Tailwind build inside its own 30 s (a cold, busy runner made a control run fail two tests on that alone): build once, up front, with its own room
test.beforeAll(async () => { test.setTimeout(180_000); await build(); });

// `classic` tries to draw a room-taking (classic, 15 px) scrollbar like a Windows / Linux browser's, and `height` makes the window short so the page really overflows — the scene for «does a scrollbar move the two-column decision?».
type Cfg = { screen: 'home' | 'home-real' | 'settings' | 'default-shell'; win: number; wide: boolean; listColumnOpen: boolean; fill?: boolean; classic?: boolean; height?: number };
const CLASSIC_SCROLLBAR_CSS = '*::-webkit-scrollbar{width:15px;height:15px}*::-webkit-scrollbar-thumb{background:#999}*::-webkit-scrollbar-track{background:#eee}';
async function open(page: Page, cfg: Cfg) {
  const { js, css } = await build();
  await page.setViewportSize({ width: cfg.win, height: cfg.height ?? 900 });
  await page.unrouteAll();
  await page.route('http://preview.test/**', async (route) => route.fulfill({ contentType: 'text/html', body: `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style>${cfg.classic ? `<style>${CLASSIC_SCROLLBAR_CSS}</style>` : ''}</head><body style="margin:0"><div id="root"></div></body></html>` }));
  const errs: string[] = [];
  page.on('pageerror', (e) => errs.push(String(e).slice(0, 300)));
  await page.goto('about:blank');
  await page.goto('http://preview.test/');
  await page.addScriptTag({ content: js });
  const full = { ...cfg, shell: shellClasses(), home: homeSources(), settings: settingsSources(cfg.win < 1024) };
  await page.evaluate((c) => (window as unknown as { __mount: (c: unknown) => void }).__mount(c), full);
  try { await page.waitForSelector('#cell *', { timeout: 8000 }); } catch (e) { throw new Error(`the scene did not draw (page errors: ${errs.join(' | ') || 'none'})`, { cause: e }); }
  await page.evaluate(() => document.fonts.ready);
  expect(errs).toEqual([]);
}

const box = (page: Page, sel: string) => page.evaluate((s) => { const e = document.querySelector(s); if (!e) return null; const r = e.getBoundingClientRect(); return { l: r.left, r: r.right, t: r.top, w: r.width, h: r.height }; }, sel);
/** the skeleton rows' heights, as a sorted list of the distinct values (a Set does not cross the page boundary) */
const skeletonHeights = (page: Page) => page.evaluate(() => [...new Set([...document.querySelectorAll('[data-testid="settings-tab-skeleton"]')].map((r) => Math.round(r.getBoundingClientRect().height)))].sort((a, b) => a - b));
const overflow = (page: Page) => page.evaluate(() => { const s = document.getElementById('scroller')!; return s.scrollWidth - s.clientWidth; });

// the window width the shell takes away from the body's cell: the icon bar 56 + the list column 256 + the inset's margin 8 (the inset has no LEFT margin beside the list column — only right/top/bottom: `lg:peer-data-[variant=inset]:m-(--shell-inset) ml-0`); the body's own padding is 24 + 24
const CHROME_W = 56 + 256 + 8;
const BODY_PAD = 48;
/** the first window at which the body (inside its padding) receives HOME_TWO_COLUMN_MIN — derived from the named numbers, not typed */
const THRESHOLD_WIN = HOME_TWO_COLUMN_MIN + BODY_PAD + CHROME_W;

const homeNumbers = async (page: Page, win: number) => {
  const cell = (await box(page, '#cell'))!, root = (await box(page, '#home-root'))!, shellRoot = (await box(page, '[data-testid="home-screen"]'))!, list = (await box(page, '#list'))!, col = await box(page, '[data-testid="home-detail-column"]');
  return { cell, root, shellRoot, list, col, win, overflow: await overflow(page) };
};

test('[SID:5031] the home\'s threshold is derived from named numbers: 340 + 16 + 360 = 716, and the window it needs follows from the chrome', () => {
  expect([HOME_DETAIL_W, HOME_GAP, HOME_LIST_MIN, HOME_TWO_COLUMN_MIN]).toEqual([340, 16, 360, 716]);
  expect(THRESHOLD_WIN).toBe(1084);
  expect(/useDetailBesideList\(HOME_TWO_COLUMN_MIN\)/.test(read('components/home/home-screen.tsx')), 'the home reads the rule from the hook with the named threshold').toBe(true);
  expect(/ref=\{bodyRef\}/.test(read('components/home/home-screen.tsx')), 'around the shell, a wrapper the hook measures').toBe(true);
});

for (const win of [1440, 1280, 1100, THRESHOLD_WIN] as const) {
  test(`[SID:5031] home ${win}: two columns — the detail is exactly 340, the list takes the rest and is never under 360, the body fills the inset, no overflow`, async ({ page }) => {
    await open(page, { screen: 'home', win, wide: true, listColumnOpen: true });
    const n = await homeNumbers(page, win);
    console.log(`[5c home] win ${win} body ${n.shellRoot.w} · list ${Math.round(n.list.w)} · detail ${n.col?.w ?? 'none (sheet)'} · overflow ${n.overflow}`);
    expect(n.root.w, 'the body root fills the content cell (no centred max-width column)').toBe(n.cell.w);
    expect(n.root.l).toBe(n.cell.l);
    expect(n.col, 'the detail column is drawn').not.toBeNull();
    expect(n.col!.w, 'exactly 340').toBe(HOME_DETAIL_W);
    expect(n.list.w, 'the list is never under 360').toBeGreaterThanOrEqual(HOME_LIST_MIN);
    expect(Math.round(n.list.w + HOME_GAP + n.col!.w), 'list + gap + detail = the body').toBe(Math.round(n.shellRoot.w));
    expect(n.list.r).toBeLessThanOrEqual(n.col!.l + 0.5);
    expect(n.overflow).toBe(0);
  });
}

test(`[SID:5031] home at the threshold exactly (${THRESHOLD_WIN}): the list is exactly its least, 360`, async ({ page }) => {
  await open(page, { screen: 'home', win: THRESHOLD_WIN, wide: true, listColumnOpen: true });
  const n = await homeNumbers(page, THRESHOLD_WIN);
  expect(Math.round(n.shellRoot.w)).toBe(HOME_TWO_COLUMN_MIN);
  expect(Math.round(n.list.w)).toBe(HOME_LIST_MIN);
});

// the sheet: the window is past lg (the grid's own `lg:` rules are ON) but the body is under 716 — no detail column, and NO empty 340 track: the list is the whole body (the trap this rule must not fall into)
for (const win of [THRESHOLD_WIN - 1, 1050, 1024, 1023] as const) {
  test(`[SID:5031] home ${win}: the sheet — no detail column, the list is the whole body (no empty 340 track), no overflow`, async ({ page }) => {
    await open(page, { screen: 'home', win, wide: false, listColumnOpen: true });
    const n = await homeNumbers(page, win);
    console.log(`[5c home] win ${win} body ${n.shellRoot.w} · list ${Math.round(n.list.w)} · detail none (sheet) · overflow ${n.overflow}`);
    expect(n.col, 'no detail column').toBeNull();
    expect(Math.round(n.list.w), 'the list takes the whole body').toBe(Math.round(n.shellRoot.w));
    expect(n.overflow).toBe(0);
  });
}

for (const [win, fill] of [[1440, false], [1100, false], [1440, true], [1100, true]] as const) {
  test(`[SID:5031] ListDetailShell DEFAULT (${win}${fill ? ' · fill' : ''}): the list is 360–420 and the detail takes the rest — unchanged (the agents frame · the inbox tabs)`, async ({ page }) => {
    await open(page, { screen: 'default-shell', win, wide: true, listColumnOpen: true, fill });
    const list = (await box(page, '#list'))!, col = (await box(page, '[data-testid="plain-detail-column"]'))!, root = (await box(page, '#home-root'))!;
    expect(list.w, `the list ${list.w}`).toBeGreaterThanOrEqual(360);
    expect(list.w).toBeLessThanOrEqual(420);
    expect(Math.round(list.w + 16 + col.w), 'the detail takes the rest').toBe(Math.round(root.w - 48));
    expect(col.w).not.toBe(340);
  });
}

for (const win of [1440, 1280, 1100] as const) {
  test(`[SID:5031] settings ${win}: the shell's list column is folded (width 0), ONE navigation of 256, rows 40 high, the pane takes the rest, no overflow`, async ({ page }) => {
    await open(page, { screen: 'settings', win, wide: true, listColumnOpen: false });
    const peer = (await box(page, '#peer-gap'))!, cell = (await box(page, '#cell'))!, nav = (await box(page, '[data-testid="settings-nav-column"]'))!, pane = (await box(page, '[data-testid="settings-pane"]'))!;
    const rows = await page.evaluate(() => [...document.querySelectorAll('[data-settings-tab], [data-settings-link]')].map((r) => Math.round(r.getBoundingClientRect().height)));
    const navs = await page.locator('[data-testid="settings-nav-column"]').count();
    console.log(`[5c settings] win ${win} peer ${peer.w} · nav ${nav.w} · pane ${Math.round(pane.w)} · rows ${[...new Set(rows)].join('/')} · overflow ${await overflow(page)}`);
    expect(peer.w, 'the shell list column takes no room').toBe(0);
    expect(navs, 'one navigation').toBe(1);
    expect(nav.w, 'the navigation column is 256').toBe(256);
    expect(rows.length).toBeGreaterThan(6);
    expect(new Set(rows), 'every section row is 40 high').toEqual(new Set([40]));
    expect(await skeletonHeights(page), 'the loading skeleton rows are the same 40 (the column does not jump when the rows arrive)').toEqual([40]);
    expect(Math.round(nav.w + pane.w), 'the pane takes the rest of the cell').toBe(Math.round(cell.w));
    expect(await overflow(page)).toBe(0);
  });
}

test('[SID:5031] settings 390 (phone): the list is as before — rows 56, the list is the whole screen (no 256 column)', async ({ page }) => {
  await open(page, { screen: 'settings', win: 390, wide: false, listColumnOpen: true });
  const rows = await page.evaluate(() => [...document.querySelectorAll('[data-settings-tab], [data-settings-link]')].map((r) => Math.round(r.getBoundingClientRect().height)));
  expect(Math.min(...rows), 'a phone row is not shortened').toBeGreaterThanOrEqual(56);
  expect(await skeletonHeights(page), 'and the skeleton rows are 56 too').toEqual([56]);
  const nav = (await box(page, '[data-testid="settings-nav-column"]'))!, cell = (await box(page, '#cell'))!;
  expect(Math.round(nav.w), 'the list takes the whole width').toBe(Math.round(cell.w));
  expect(await overflow(page)).toBe(0);
});

// codex 5c: the exact 1024 boundary of the settings list, and a FINGER (coarse pointer) from lg up — the 44 floor of the repo's `touch` variant applies at lg too (a tablet is ≥ lg); a phone keeps its 56 with or without touch.
test('[SID:5031] settings 1024 (the lg boundary exactly): the shell list column is folded, the navigation is 256, the rows and the skeleton rows are 40', async ({ page }) => {
  await open(page, { screen: 'settings', win: 1024, wide: true, listColumnOpen: false });
  const peer = (await box(page, '#peer-gap'))!, nav = (await box(page, '[data-testid="settings-nav-column"]'))!, cell = (await box(page, '#cell'))!, pane = (await box(page, '[data-testid="settings-pane"]'))!;
  const rows = await page.evaluate(() => [...document.querySelectorAll('[data-settings-tab], [data-settings-link]')].map((r) => Math.round(r.getBoundingClientRect().height)));
  console.log(`[5c settings] win 1024 peer ${peer.w} · nav ${nav.w} · pane ${Math.round(pane.w)} · rows ${[...new Set(rows)].join('/')}`);
  expect([peer.w, nav.w]).toEqual([0, 256]);
  expect(new Set(rows)).toEqual(new Set([40]));
  expect(await skeletonHeights(page)).toEqual([40]);
  expect(Math.round(nav.w + pane.w)).toBe(Math.round(cell.w));
  expect(await overflow(page)).toBe(0);
});

test.describe('a finger (coarse pointer)', () => {
  test.use({ hasTouch: true });
  for (const win of [1280, 1024] as const) {
    test(`[SID:5031] settings ${win} with touch: the rows and the skeleton rows are 44 (the touch floor), not 40`, async ({ page }) => {
      await open(page, { screen: 'settings', win, wide: true, listColumnOpen: false });
      expect(await page.evaluate(() => matchMedia('(pointer: coarse)').matches), 'the scene is a coarse-pointer one').toBe(true);
      const rows = await page.evaluate(() => [...document.querySelectorAll('[data-settings-tab], [data-settings-link]')].map((r) => Math.round(r.getBoundingClientRect().height)));
      console.log(`[5c settings touch] win ${win} rows ${[...new Set(rows)].join('/')} · skeleton ${(await skeletonHeights(page)).join('/')}`);
      expect(new Set(rows)).toEqual(new Set([44]));
      expect(await skeletonHeights(page)).toEqual([44]);
      expect(await overflow(page)).toBe(0);
    });
  }
  test('[SID:5031] settings 390 with touch: a phone keeps its 56 (rows and skeleton) — the touch floor is the lg rule only', async ({ page }) => {
    await open(page, { screen: 'settings', win: 390, wide: false, listColumnOpen: true });
    const rows = await page.evaluate(() => [...document.querySelectorAll('[data-settings-tab], [data-settings-link]')].map((r) => Math.round(r.getBoundingClientRect().height)));
    expect(new Set(rows)).toEqual(new Set([56]));
    expect(await skeletonHeights(page)).toEqual([56]);
  });
});

// codex 5c: the REAL home screen with the longest names (40 Korean letters with no space · 60 Latin letters · long titles / reasons): in the 340 detail column and in the list rows nothing runs past its box, at the threshold and wide
for (const win of [THRESHOLD_WIN, 1440] as const) {
  test(`[SID:5031] home ${win} (the real HomeScreen · very long names and titles): the detail card and every list row hold their content, no overflow`, async ({ page }) => {
    await open(page, { screen: 'home-real', win, wide: true, listColumnOpen: true });
    const check = () => page.evaluate(() => {
      const inside = (outer: Element, sel: string) => { const o = outer.getBoundingClientRect(); return [...outer.querySelectorAll(sel)].filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && (r.right > o.right + 0.5 || r.left < o.left - 0.5); }).map((e) => `${e.tagName.toLowerCase()}:${(e.textContent ?? '').slice(0, 20)}`); };
      // text that runs past its own box: an element whose content is wider than it (scrollWidth > clientWidth) — except a deliberate one-line cut (overflow hidden + text-overflow ellipsis) and the 1px screen-reader-only text (`sr-only`)
      const spill = (outer: Element) => [...outer.querySelectorAll('*')].filter((e) => { const cs = getComputedStyle(e); return e.scrollWidth > e.clientWidth + 1 && e.clientWidth > 1 && !(cs.overflowX === 'hidden' && cs.textOverflow === 'ellipsis'); }).map((e) => `${e.tagName.toLowerCase()}:${(e.textContent ?? '').slice(0, 20)}`);
      const detail = document.querySelector('[data-testid="home-detail"]')!;
      const col = document.querySelector('[data-testid="home-detail-column"]')!.getBoundingClientRect();
      const rows = [...document.querySelectorAll('[data-row-key]')];
      return { detailW: Math.round(col.width), detailScroll: detail.scrollWidth - detail.clientWidth, detailOut: [...inside(detail, '*'), ...spill(detail)], rows: rows.length, rowsScroll: rows.map((r) => r.scrollWidth - r.clientWidth), rowsOut: rows.flatMap((r) => [...inside(r, '*'), ...spill(r)]) };
    });
    let m = await check();
    console.log(`[5c home real] win ${win} detail ${m.detailW} · rows ${m.rows} · detail overflow ${m.detailScroll} · out ${m.detailOut.length + m.rowsOut.length}`);
    expect(m.detailW).toBe(HOME_DETAIL_W);
    expect(m.rows).toBeGreaterThanOrEqual(2);
    expect(m.detailScroll, 'the detail card does not scroll sideways').toBeLessThanOrEqual(0);
    expect(m.detailOut, 'nothing in the detail card runs past it').toEqual([]);
    expect(m.rowsScroll.every((x) => x <= 0), 'no list row scrolls sideways').toBe(true);
    expect(m.rowsOut, 'nothing in a list row runs past it').toEqual([]);
    // the other row's detail (the Latin name · the signature card). Press the row's TITLE button, not «the middle of the row»: the middle of a row can be the row's own action link (a click there goes where the link goes — the scene is gone) — where the middle falls
    // depends on the font's metrics (the 5c CI red: Linux's fonts put it on the link, the Mac's did not). The title button is the row's own «select» (the same as a click on the row's body).
    await page.locator('[data-row-key]').nth(1).locator('button').first().click();
    await expect(page.locator('[data-testid="home-detail"]'), 'the click selected the row (it did not leave the page through the row\'s link)').toHaveAttribute('data-row-key', 'gate:g2');
    m = await check();
    expect(m.detailScroll).toBeLessThanOrEqual(0);
    expect(m.detailOut).toEqual([]);
    // a row that is NOT a request (a working run — its detail is the «facts» card with the agent's long name): the section is folded by default
    await page.locator('section[aria-label="일하는 중"] button').first().click();
    await page.locator('[data-row-key="run:r1"] button').first().click();
    expect(await page.locator('[data-testid="home-detail-facts"]').count(), 'the facts card is the detail now').toBe(1);
    m = await check();
    expect(m.detailScroll).toBeLessThanOrEqual(0);
    expect(m.detailOut, 'the facts card holds a long agent name').toEqual([]);
    expect(m.rowsOut).toEqual([]);
    expect(await overflow(page)).toBe(0);
  });
}

// the 5c CI red was NOT a scrollbar (the product hides every scrollbar: `* { scrollbar-width: none }` + `*::-webkit-scrollbar { display: none }` in globals.css — a scrollbar takes no room from the shell's scroller on any platform, so the body is as wide with
// a tall page as with a short one). Pinned here so a later «show the scrollbars» change cannot silently move the two-column threshold: a SHORT window (the page overflows and scrolls), an attempt at a classic 15 px scrollbar, the threshold ±1, and a
// press on the second row — the decision stays the same, and nothing flips between two columns and the sheet.
test.describe('the shell scroller takes no room for a scrollbar (a short window · a classic-scrollbar attempt)', () => {
  const scene = (page: Page) => page.evaluate(() => {
    const sc = document.getElementById('scroller')!;
    const body = document.querySelector('[data-testid="home-width-probe"]')!.getBoundingClientRect();
    return { scrollbar: sc.offsetWidth - sc.clientWidth, overflowsY: sc.scrollHeight > sc.clientHeight, bodyW: Math.round(body.width), column: document.querySelector('[data-testid="home-detail-column"]') !== null, sheet: document.querySelector('[data-testid="home-detail-sheet"]') !== null };
  });
  for (const classic of [false, true] as const) {
    test(`[SID:5031] home ${THRESHOLD_WIN} in a short window${classic ? ' with a classic-scrollbar attempt' : ''}: the page scrolls, no scrollbar room is taken, two columns hold — before and after a press on the second row`, async ({ page }) => {
      await open(page, { screen: 'home-real', win: THRESHOLD_WIN, wide: true, listColumnOpen: true, height: 520, classic });
      const before = await scene(page);
      console.log(`[5c home short${classic ? ' classic' : ''}] before ${JSON.stringify(before)}`);
      expect(before.overflowsY, 'the scene really overflows (a scrollbar would have a reason to exist)').toBe(true);
      expect(before.scrollbar, 'the shell scroller takes no room for a scrollbar').toBe(0);
      expect(before).toMatchObject({ bodyW: HOME_TWO_COLUMN_MIN, column: true, sheet: false });
      await page.locator('[data-row-key]').nth(1).locator('button').first().click();
      const after = await scene(page);
      expect(after).toMatchObject({ scrollbar: 0, bodyW: HOME_TWO_COLUMN_MIN, column: true, sheet: false });
    });
    test(`[SID:5031] home ${THRESHOLD_WIN - 1} in a short window${classic ? ' with a classic-scrollbar attempt' : ''}: one less is the sheet — and it stays the sheet after a press on a row (no flipping)`, async ({ page }) => {
      await open(page, { screen: 'home-real', win: THRESHOLD_WIN - 1, wide: true, listColumnOpen: true, height: 520, classic });
      const before = await scene(page);
      expect(before).toMatchObject({ scrollbar: 0, bodyW: HOME_TWO_COLUMN_MIN - 1, column: false });
      await page.locator('[data-row-key]').nth(1).locator('button').first().click();
      expect(await scene(page)).toMatchObject({ scrollbar: 0, bodyW: HOME_TWO_COLUMN_MIN - 1, column: false });
    });
  }
});
