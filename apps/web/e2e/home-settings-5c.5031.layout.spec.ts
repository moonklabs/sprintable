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
import { tailwindCandidates } from './support/tailwind-candidates';

const req = createRequire(__filename);
const WEB = path.join(__dirname, '..');
const SRC = path.join(WEB, 'src');
const APP = path.join(SRC, 'app');
const read = (rel: string) => readFileSync(path.join(SRC, rel), 'utf8');
const pick = (src: string, re: RegExp, what: string) => { const m = re.exec(src); if (!m) throw new Error(`${what} not found`); return m[1]!; };

function shellClasses() {
  const sidebar = read('components/ui/sidebar.tsx');
  const shell = read('app/dashboard/dashboard-shell.tsx');
  const panel = read('components/ui/contextual-panel-layout.tsx');
  const [, gridBase, gridCols] = /cn\('([^']+)', inlinePanelOpen \? inlineColumnsClassName : '([^']+)', className\)/.exec(panel) ?? [];
  if (!gridBase || !gridCols) throw new Error('contextual-panel-layout.tsx: the grid classes not found');
  const cellBase = pick(panel, /<div className=\{cn\('([^']+)', contentClassName\)\}>/, 'contextual-panel-layout.tsx: the content cell');
  return {
    // the sidebar's gap element (the room the list column takes in the row): its own classes, folded = width 0
    gap: pick(sidebar, /data-slot="sidebar-gap"\s*className=\{cn\(\s*"(relative w-\(--sidebar-width\) bg-transparent)"/, 'sidebar.tsx: the sidebar gap') + ' ' + pick(sidebar, /"(group-data-\[collapsible=offcanvas\]:w-0)"/, 'sidebar.tsx: the offcanvas fold'),
    wrapper: `${pick(sidebar, /"(group\/sidebar-wrapper [^"]+)"/, 'sidebar.tsx: the provider wrapper')} ${pick(shell, /<SidebarProvider className="([^"]+)"/, 'dashboard-shell.tsx: SidebarProvider class')}`,
    peer: pick(sidebar, /className="(group peer [^"]+)"\s*data-state=\{state\}/, 'sidebar.tsx: the sidebar peer'),
    inset: `${pick(sidebar, /data-slot="sidebar-inset"\s*className=\{cn\(\s*"([^"]+)"/, 'sidebar.tsx: the inset main')} ${pick(shell, /<SidebarInset className=\{cn\('([^']+)'/, 'dashboard-shell.tsx: SidebarInset class')}`,
    scroller: pick(shell, /<div ref=\{setRef\} className="([^"]+)"/, 'dashboard-shell.tsx: the shell scroller'),
    grid: `${gridBase} ${gridCols} ${pick(shell, /className="([^"]+)"\s*inlineColumnsClassName=/, 'dashboard-shell.tsx: ContextualPanelLayout className')}`,
    content: `${cellBase} ${pick(shell, /contentClassName=\{cn\(\s*'([^']+)'/, 'dashboard-shell.tsx: ContextualPanelLayout contentClassName')}`,
  };
}
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
        import { SettingsNav } from './src/app/(authenticated)/settings/settings-nav-list';
        import { settingsNavGroups } from './src/app/(authenticated)/settings/settings-nav';
        const groups = settingsNavGroups({ adminChecked: true, isAdmin: true, inPhoneApp: false, supportWidget: true, billing: true });
        const Shell = ({ cfg, children }) => (
          <div className={cfg.shell.wrapper} style={{ '--sidebar-width': '16rem' }}>
            {/* the icon bar (nav-rail: w-14 = 56) stands left of the list column in the real shell */}
            <div id="rail" className="hidden w-14 shrink-0 lg:block" />
            <div className={cfg.shell.peer} data-state={cfg.listColumnOpen ? 'expanded' : 'collapsed'} data-collapsible={cfg.listColumnOpen ? '' : 'offcanvas'} data-variant="inset" data-side="left" id="peer"><div data-slot="sidebar-gap" className={cfg.shell.gap} id="peer-gap" /></div>
            <main id="inset" className={cfg.shell.inset}><div id="scroller" className={cfg.shell.scroller}><div className={cfg.shell.grid}><div id="cell" className={cfg.shell.content}>{children}</div></div></div></main>
          </div>);
        window.__mount = (cfg) => {
          const body = cfg.screen === 'home'
            ? (<div id="home-root" className={cfg.home.root}>
                <ListDetailShell testId="home-screen" columnTestId="home-detail-column" sheetTestId="home-detail-sheet" wide={cfg.wide} detailWidth={cfg.home.detailWidth === 'fixed' ? 'fixed' : undefined}
                  list={<div id="list" className="min-w-0 rounded-ds-control border border-ds-line p-4" style={{ height: '320px' }}>list</div>}
                  detail={<div id="detail" className="rounded-ds-control border border-ds-line p-4" style={{ height: '320px' }}>detail</div>}
                  detailLabel="요청" sheetLabel="자세히" sheetOpen={false} onSheetOpenChange={() => {}} />
              </div>)
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

type Cfg = { screen: 'home' | 'settings' | 'default-shell'; win: number; wide: boolean; listColumnOpen: boolean; fill?: boolean };
async function open(page: Page, cfg: Cfg) {
  const { js, css } = await build();
  await page.setViewportSize({ width: cfg.win, height: 900 });
  await page.unrouteAll();
  await page.route('http://preview.test/**', async (route) => route.fulfill({ contentType: 'text/html', body: `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head><body style="margin:0"><div id="root"></div></body></html>` }));
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
const overflow = (page: Page) => page.evaluate(() => { const s = document.getElementById('scroller')!; return s.scrollWidth - s.clientWidth; });

for (const win of [1440, 1280, 1100, 1024] as const) {
  test(`[SID:5031] home ${win}: the body fills the inset, the detail is exactly 340, the list takes the rest, no overflow`, async ({ page }) => {
    await open(page, { screen: 'home', win, wide: true, listColumnOpen: true });
    const cell = (await box(page, '#cell'))!, root = (await box(page, '#home-root'))!, list = (await box(page, '#list'))!, col = (await box(page, '[data-testid="home-detail-column"]'))!;
    console.log(`[5c home] win ${win} cell ${cell.w} · root ${root.w} (x+${root.l - cell.l}) · list ${Math.round(list.w)} · detail ${col.w} · overflow ${await overflow(page)}`);
    expect(root.w, 'the body root fills the content cell (no centred max-width column)').toBe(cell.w);
    expect(root.l, 'and starts at its left edge').toBe(cell.l);
    expect(col.w, 'the detail column is exactly 340').toBe(340);
    // list = root − the body padding (24 + 24) − the gap (16) − 340
    expect(Math.round(list.w)).toBe(Math.round(root.w - 48 - 16 - 340));
    expect(list.r, 'the list is left of the detail').toBeLessThanOrEqual(col.l + 0.5);
    expect(await overflow(page)).toBe(0);
  });
}

test('[SID:5031] home 1023: below lg there is no detail column (it is a sheet) and the list takes the whole body — the phone shape is as before', async ({ page }) => {
  await open(page, { screen: 'home', win: 1023, wide: false, listColumnOpen: true });
  expect(await box(page, '[data-testid="home-detail-column"]')).toBeNull();
  const root = (await box(page, '#home-root'))!, list = (await box(page, '#list'))!;
  expect(Math.round(list.w)).toBe(Math.round(root.w - 32)); // the phone body padding is 16 + 16 (p-4)
  expect(await overflow(page)).toBe(0);
});

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
    expect(Math.round(nav.w + pane.w), 'the pane takes the rest of the cell').toBe(Math.round(cell.w));
    expect(await overflow(page)).toBe(0);
  });
}

test('[SID:5031] settings 390 (phone): the list is as before — rows 56, the list is the whole screen (no 256 column)', async ({ page }) => {
  await open(page, { screen: 'settings', win: 390, wide: false, listColumnOpen: true });
  const rows = await page.evaluate(() => [...document.querySelectorAll('[data-settings-tab], [data-settings-link]')].map((r) => Math.round(r.getBoundingClientRect().height)));
  expect(Math.min(...rows), 'a phone row is not shortened').toBeGreaterThanOrEqual(56);
  const nav = (await box(page, '[data-testid="settings-nav-column"]'))!, cell = (await box(page, '#cell'))!;
  expect(Math.round(nav.w), 'the list takes the whole width').toBe(Math.round(cell.w));
  expect(await overflow(page)).toBe(0);
});
