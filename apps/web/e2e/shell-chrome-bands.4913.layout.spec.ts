/**
 * story 4913 (UI-R5 · shell) — the shell answers for the height it eats. Two things sit between the viewport and a screen's anchor
 * (`h-[calc(100svh-var(--shell-chrome-h))]`): the «only when there is one» bands on top of the scroller (sign-up checklist · another org's notice ·
 * reclaim notice — 0 to ~100 px) and the round support button's room (4rem, only while the button is drawn: `<html data-support-launcher>`).
 * Before: --shell-chrome-h counted the TopBar only, so an anchored page overflowed by the bands' height (dev 1100×420, one 34 px band: the frame's
 * bottom 454 > main's bottom 412, the document scrolled 74 px) and the button covered the screen's bottom-right presses.
 *
 * Layout is the browser's job, so this runs in Chromium: the shell chain is built with its OWN class strings read from the sources, the REAL Tailwind
 * build of globals.css, the REAL `watchShellBandsHeight` (esbuild-bundled, real ResizeObserver), and every anchor's class string READ from its screen's
 * source (a new consumer of the variable must be added to the table — the last test counts them). No server.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { expect, test, type Page } from '@playwright/test';
import { compile, optimize } from '@tailwindcss/node';

const req = createRequire(__filename);
const WEB = path.join(__dirname, '..');
const SRC = path.join(WEB, 'src');
const APP = path.join(SRC, 'app');
const read = (rel: string) => readFileSync(path.join(SRC, rel), 'utf8');

/** the screens that anchor their height on the one variable — class string read from each source (comments are skipped: only `className="…"` / the goals `frame` template) */
const ANCHORS: Array<{ name: string; file: string; re: RegExp }> = [
  { name: 'docs', file: 'app/(authenticated)/[ws]/[proj]/docs/docs-client-layout.tsx', re: /className="([^"]*h-\[calc\(100svh-var\(--shell-chrome-h\)[^"]*)"/ },
  { name: 'flow', file: 'app/(authenticated)/[ws]/[proj]/flow/flow-client.tsx', re: /className="([^"]*h-\[calc\(100svh-var\(--shell-chrome-h\)[^"]*)"/ },
  { name: 'goals', file: 'app/(authenticated)/[ws]/[proj]/goals/goals-client.tsx', re: /const frame = `([^`]*h-\[calc\(100svh-var\(--shell-chrome-h\)[^`]*)`/ },
  { name: 'sprints', file: 'app/(authenticated)/[ws]/[proj]/sprints/sprints-client.tsx', re: /className="([^"]*h-\[calc\(100svh-var\(--shell-chrome-h\)[^"]*)"/ },
  { name: 'chats', file: 'app/(authenticated)/chats/layout.tsx', re: /className="([^"]*h-\[calc\(100svh-var\(--shell-chrome-h\)[^"]*)"/ },
  { name: 'inbox', file: 'app/(authenticated)/inbox/page.tsx', re: /className="([^"]*h-\[calc\(100svh-var\(--shell-chrome-h\)[^"]*)"/ },
  { name: 'settings', file: 'app/(authenticated)/settings/page.tsx', re: /className="([^"]*h-\[calc\(100svh-var\(--shell-chrome-h\)[^"]*)"/ },
];

function anchorClass(a: (typeof ANCHORS)[number]): string {
  const m = a.re.exec(read(a.file));
  if (!m) throw new Error(`${a.name}: the anchor class string was not found in ${a.file}`);
  return m[1]!.replace(/\$\{[^}]*\}/g, '').trim();
}

function shellClasses() {
  const pick = (src: string, re: RegExp, what: string) => { const m = re.exec(src); if (!m) throw new Error(`${what} not found`); return m[1]!; };
  const sidebar = read('components/ui/sidebar.tsx');
  const shell = read('app/dashboard/dashboard-shell.tsx');
  const panel = read('components/ui/contextual-panel-layout.tsx');
  const [, gridBase, gridCols] = /cn\('([^']+)', inlinePanelOpen \? inlineColumnsClassName : '([^']+)', className\)/.exec(panel) ?? [];
  if (!gridBase || !gridCols) throw new Error('contextual-panel-layout.tsx: the grid classes not found');
  const cellBase = pick(panel, /<div className=\{cn\('([^']+)', contentClassName\)\}>/, 'contextual-panel-layout.tsx: the content cell');
  return {
    wrapper: `${pick(sidebar, /"(group\/sidebar-wrapper [^"]+)"/, 'sidebar.tsx: the provider wrapper')} ${pick(shell, /<SidebarProvider className="([^"]+)"/, 'dashboard-shell.tsx: SidebarProvider class')}`,
    peer: pick(sidebar, /className="(group peer [^"]+)"\s*data-state=\{state\}/, 'sidebar.tsx: the sidebar peer'),
    inset: `${pick(sidebar, /data-slot="sidebar-inset"\s*className=\{cn\(\s*"([^"]+)"/, 'sidebar.tsx: the inset main')} ${pick(shell, /<SidebarInset className=\{cn\('([^']+)'/, 'dashboard-shell.tsx: SidebarInset class')}`,
    scroller: pick(shell, /<div ref=\{setRef\} className="([^"]+)"/, 'dashboard-shell.tsx: the shell scroller'),
    grid: `${gridBase} ${gridCols} ${pick(shell, /className="([^"]+)"\s*inlineColumnsClassName=/, 'dashboard-shell.tsx: ContextualPanelLayout className')}`,
    content: `${cellBase} ${pick(shell, /contentClassName=\{cn\(\s*'([^']+)'/, 'dashboard-shell.tsx: ContextualPanelLayout contentClassName')}`,
    topBar: pick(read('components/nav/top-bar.tsx'), /'(@container flex h-12 [^']+)'/, 'top-bar.tsx: the TopBar'),
    band: pick(shell, /<div className="(px-3 pt-3 empty:hidden)">/, 'dashboard-shell.tsx: a band wrapper'),
  };
}

let watchJs: string | null = null;
async function bundleWatch() {
  if (watchJs) return watchJs;
  const esbuild = req('esbuild') as typeof import('esbuild');
  const out = await esbuild.build({
    stdin: { contents: "import { watchShellBandsHeight } from './src/components/nav/shell-bands-height'; window.__watch = watchShellBandsHeight;", resolveDir: WEB, loader: 'ts' },
    bundle: true, format: 'iife', platform: 'browser', write: false, logLevel: 'silent', tsconfig: path.join(WEB, 'tsconfig.json'),
  });
  watchJs = out.outputFiles[0]!.text;
  return watchJs;
}

async function css(classes: string[]): Promise<string> {
  const compiler = await compile(readFileSync(path.join(APP, 'globals.css'), 'utf8'), { base: APP, onDependency: () => {} });
  return (optimize as unknown as (c: string, o?: object) => { code: string })(compiler.build(classes), { minify: false }).code;
}

type Opts = { width: number; height: number; bands: number; launcher: boolean; anchor: (typeof ANCHORS)[number] | 'page' };
const BAND_H = 34;
const BAND_BOX = BAND_H + 12; // a band's wrapper has `pt-3` (12px) — the box the shell measures

/** the shell as dashboard-shell renders it around one anchored page (a TopBar, the bands wrapper, the grid/cell, the anchor with an inner scroller and a press at its bottom-right corner) */
async function mount(page: Page, o: Opts) {
  const c = shellClasses();
  const anchor = o.anchor === 'page' ? '' : anchorClass(o.anchor);
  const all = [...Object.values(c), anchor].join(' ').split(/\s+/).filter(Boolean);
  const noTopBar = o.anchor !== 'page' && o.anchor.name === 'settings'; // /settings draws no TopBar (data-topbar-hidden)
  const phone = o.width < 1024;
  await page.setViewportSize({ width: o.width, height: o.height });
  const bands = Array.from({ length: o.bands }, (_, i) => `<div class="${c.band}" data-band="${i}"><div style="height:${BAND_H}px">band ${i}</div></div>`).join('');
  const body = o.anchor === 'page'
    ? '<div id="tall" style="height:3000px"><div id="stick" style="position:sticky;top:0;height:30px">sticky</div></div>'
    : `<div id="anchor" class="${anchor}"><div style="position:relative;flex:1;min-height:0;min-width:0;height:100%;width:100%"><div style="height:100%;overflow-y:auto"><div style="height:3000px">content</div></div><button id="corner" style="position:absolute;right:0;bottom:0;width:40px;height:30px">press</button></div></div>`;
  await page.setContent(`<!doctype html><html${o.launcher ? ' data-support-launcher=""' : ''}><head><style>html,body{margin:0}${await css(all)}</style></head><body>
    <div class="${c.wrapper}"${noTopBar ? ' data-topbar-hidden=""' : ''}>
      <div class="${c.peer}" data-state="expanded" data-collapsible="" data-variant="inset" data-side="left"><div style="width:256px"></div></div>
      <main id="inset" class="${c.inset}">
        <div id="scroller" class="${c.scroller}">
          ${noTopBar ? '' : `<div id="topbar" class="${c.topBar}">TopBar</div>`}
          <div id="bands" data-shell-bands>${bands}</div>
          <div class="${c.grid}"><div class="${c.content}">${body}</div></div>
        </div>
        ${phone ? '<div id="tabbar" style="flex-shrink:0;height:var(--mobile-tab-bar-h)">tabs</div>' : ''}
      </main>
    </div>
    ${o.launcher ? `<div id="launcher" style="position:fixed;right:16px;bottom:${phone ? 'calc(4rem + 16px)' : '16px'};width:48px;height:48px;border-radius:50%"></div>` : ''}
  </body></html>`);
  await page.addScriptTag({ content: await bundleWatch() });
  await page.evaluate(() => (window as unknown as { __watch: (el: Element) => void }).__watch(document.getElementById('bands')!));
}

const measure = (page: Page) => page.evaluate(() => {
  const r = (id: string) => document.getElementById(id)?.getBoundingClientRect();
  const s = document.getElementById('scroller')!;
  const root = document.querySelector('.dashboard-shell-root') as HTMLElement;
  return {
    over: s.scrollHeight - s.clientHeight,
    docOver: document.documentElement.scrollHeight - window.innerHeight,
    anchorBottom: r('anchor')?.bottom ?? NaN, insetBottom: r('inset')!.bottom,
    corner: r('corner') ? { l: r('corner')!.left, t: r('corner')!.top, r: r('corner')!.right, b: r('corner')!.bottom } : null,
    launcher: r('launcher') ? { l: r('launcher')!.left, t: r('launcher')!.top, r: r('launcher')!.right, b: r('launcher')!.bottom } : null,
    bandsVar: root.style.getPropertyValue('--shell-bands-h'),
  };
});

const SIZES = [[1440, 900], [1100, 420], [1024, 768], [390, 844]] as const;

for (const anchor of ANCHORS) {
  for (const [width, height] of SIZES) {
    for (const bands of [0, 1, 3]) {
      for (const launcher of [false, true]) {
        test(`[SID:4913] ${anchor.name} ${width}×${height} · bands ${bands} · button ${launcher ? 'drawn' : 'not drawn'}: the frame fits the main, the document does not scroll`, async ({ page }) => {
          await mount(page, { width, height, bands, launcher, anchor });
          const m = await measure(page);
          expect(m.bandsVar, 'the shell wrote the bands height').toBe(`${bands * BAND_BOX}px`);
          expect(m.over, 'the shell scroller does not overflow').toBeLessThanOrEqual(0);
          expect(m.docOver, 'the document does not scroll').toBeLessThanOrEqual(0);
          expect(m.anchorBottom, 'the frame ends inside the main').toBeLessThanOrEqual(m.insetBottom + 0.5);
          // the strip left under the frame (above the phone's tab bar) is exactly the room the button needs (4rem) when drawn, nothing when not
          const tabBar = width < 1024 ? (await page.evaluate(() => document.getElementById('tabbar')!.getBoundingClientRect().height)) : 0;
          const gap = m.insetBottom - tabBar - m.anchorBottom;
          if (launcher) expect(Math.round(gap)).toBeGreaterThanOrEqual(64); else expect(Math.round(gap)).toBeLessThanOrEqual(1);
          if (launcher && m.corner && m.launcher) {
            const overlap = m.corner.l < m.launcher.r && m.corner.r > m.launcher.l && m.corner.t < m.launcher.b && m.corner.b > m.launcher.t;
            expect(overlap, 'the round button does not cover a press at the frame corner').toBe(false);
          }
        });
      }
    }
  }
}

test('[SID:4913] the bands come and go while the screen is open: the value follows and nothing overflows (sign-up checklist closed · 5/5 · a notice arrives)', async ({ page }) => {
  await mount(page, { width: 1100, height: 420, bands: 3, launcher: false, anchor: ANCHORS[5]! });
  let m = await measure(page);
  expect(m.bandsVar).toBe(`${3 * BAND_BOX}px`);
  expect(m.over).toBeLessThanOrEqual(0);
  await page.evaluate(() => document.querySelector('[data-band="1"]')!.remove());
  await page.evaluate(() => document.querySelector('[data-band="2"]')!.remove());
  await page.waitForFunction((v) => (document.querySelector('.dashboard-shell-root') as HTMLElement).style.getPropertyValue('--shell-bands-h') === v, `${BAND_BOX}px`);
  m = await measure(page);
  expect(m.over).toBeLessThanOrEqual(0);
  expect(m.docOver).toBeLessThanOrEqual(0);
  await page.evaluate(() => { document.getElementById('bands')!.innerHTML = ''; });
  await page.waitForFunction(() => (document.querySelector('.dashboard-shell-root') as HTMLElement).style.getPropertyValue('--shell-bands-h') === '0px');
  m = await measure(page);
  expect(m.over).toBeLessThanOrEqual(0);
  await page.evaluate((cls) => {
    const d = document.createElement('div'); d.className = cls; d.innerHTML = '<div style="height:50px">a notice</div>';
    document.getElementById('bands')!.appendChild(d);
  }, shellClasses().band);
  await page.waitForFunction(() => (document.querySelector('.dashboard-shell-root') as HTMLElement).style.getPropertyValue('--shell-bands-h') === '62px');
  m = await measure(page);
  expect(m.over).toBeLessThanOrEqual(0);
});

test('[SID:4913] the button appearing or going while the screen is open: the room follows', async ({ page }) => {
  await mount(page, { width: 1440, height: 900, bands: 1, launcher: false, anchor: ANCHORS[4]! });
  let m = await measure(page);
  const g0 = m.insetBottom - m.anchorBottom;
  expect(Math.round(g0)).toBeLessThanOrEqual(1);
  await page.evaluate(() => document.documentElement.setAttribute('data-support-launcher', ''));
  m = await measure(page);
  expect(Math.round(m.insetBottom - m.anchorBottom)).toBeGreaterThanOrEqual(64);
  expect(m.over).toBeLessThanOrEqual(0);
  await page.evaluate(() => document.documentElement.removeAttribute('data-support-launcher'));
  m = await measure(page);
  expect(Math.round(m.insetBottom - m.anchorBottom)).toBeLessThanOrEqual(1);
});

test('[SID:4913] a long page (no anchor) still lets `position: sticky` work against the shell scroller, with the bands and the button room in place (the 4130 rule is untouched)', async ({ page }) => {
  await mount(page, { width: 1440, height: 700, bands: 3, launcher: true, anchor: 'page' });
  await page.evaluate(() => { document.getElementById('scroller')!.scrollTop = 400; });
  const stuck = await page.evaluate(() => {
    const st = document.getElementById('stick')!.getBoundingClientRect();
    const sc = document.getElementById('scroller')!.getBoundingClientRect();
    return { stickTop: st.top, scrollerTop: sc.top, scrolled: document.getElementById('scroller')!.scrollTop };
  });
  expect(stuck.scrolled).toBeGreaterThan(0);
  expect(Math.round(stuck.stickTop - stuck.scrollerTop)).toBeLessThanOrEqual(0 + 1); // stuck at the scroller's top edge (under the sticky TopBar), not scrolled away
  expect(stuck.stickTop).toBeGreaterThanOrEqual(stuck.scrollerTop - 1);
});

test('[SID:4913] a long page while the button is drawn: scrolled to the end, the last line sits above the button (the room is also the scroller\'s tail)', async ({ page }) => {
  await mount(page, { width: 1440, height: 700, bands: 1, launcher: true, anchor: 'page' });
  await page.evaluate(() => { const sc = document.getElementById('scroller')!; sc.scrollTop = sc.scrollHeight; });
  const m = await page.evaluate(() => {
    const tall = document.getElementById('tall')!.getBoundingClientRect();
    const launcher = document.getElementById('launcher')!.getBoundingClientRect();
    return { tallBottom: tall.bottom, launcherTop: launcher.top };
  });
  expect(m.tallBottom, 'the end of the page clears the round button').toBeLessThanOrEqual(m.launcherTop + 0.5);
});

test('[SID:4913] every use of `100svh-var(--shell-chrome-h` in the app is a row of the table above (a new consumer must be added here — and is then measured with the bands and the button)', () => {
  const files = [
    'app/(authenticated)/[ws]/[proj]/docs/docs-client-layout.tsx', 'app/(authenticated)/[ws]/[proj]/flow/flow-client.tsx', 'app/(authenticated)/[ws]/[proj]/goals/goals-client.tsx',
    'app/(authenticated)/[ws]/[proj]/sprints/sprints-client.tsx', 'app/(authenticated)/chats/layout.tsx', 'app/(authenticated)/inbox/page.tsx', 'app/(authenticated)/settings/page.tsx',
    'app/dashboard/dashboard-shell.tsx',
  ];
  const code = (f: string) => read(f).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  for (const f of files) expect(code(f), f).toContain('100svh-var(--shell-chrome-h');
  // nothing else reads it: scan the whole app tree for code uses
  const { execFileSync } = req('node:child_process') as typeof import('node:child_process');
  const found = execFileSync('grep', ['-rl', '100svh-var(--shell-chrome-h', SRC, '--include=*.tsx', '--include=*.ts'], { encoding: 'utf8' }).split('\n').filter(Boolean)
    .map((p) => path.relative(SRC, p)).filter((p) => !p.endsWith('.test.tsx') && !p.endsWith('.test.ts')).sort();
  const known = new Set(files);
  const unknown = found.filter((p) => { const body = code(p); return body.includes('100svh-var(--shell-chrome-h') && !known.has(p); });
  expect(unknown, 'a new screen anchors on --shell-chrome-h — add it to ANCHORS').toEqual([]);
});
