/**
 * story #4534 — on lg and up every page anchored with `h-[calc(100svh-var(--shell-chrome-h))]` (chat · inbox · settings · docs …)
 * overflowed the shell's scroller by 16px (dev-app 1440 · 1024 measured): the SidebarInset main stands --shell-inset off the inset
 * sidebar on every side, and --shell-chrome-h counted the TopBar only. The chat opened 16px down and the agent DM's session strip
 * lost its first line under the TopBar. Both now read the one --shell-inset.
 *
 * Layout is the browser's job (jsdom computes none), so this runs in Chromium: the sidebar wrapper · its peer · the inset main ·
 * the shell scroller · the TopBar · the chat column's anchor are built with their OWN class strings, read from the sources, and the
 * real Tailwind build of globals.css for those classes. No server.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { compile, optimize } from '@tailwindcss/node';

const SRC = path.join(__dirname, '../src');
const APP = path.join(SRC, 'app');
const read = (rel: string) => readFileSync(path.join(SRC, rel), 'utf8');

/** the class strings of the shell chain (drift-proof: read from the sources, not copied) */
function classesFromSource() {
  const pick = (src: string, re: RegExp, what: string) => { const m = re.exec(src); if (!m) throw new Error(`${what} not found`); return m[1]!; };
  const sidebar = read('components/ui/sidebar.tsx');
  const shell = read('app/dashboard/dashboard-shell.tsx');
  const panel = read('components/ui/contextual-panel-layout.tsx');
  const [, gridBase, gridCols] = /cn\('([^']+)', inlinePanelOpen \? inlineColumnsClassName : '([^']+)', className\)/.exec(panel) ?? [];
  if (!gridBase || !gridCols) throw new Error('contextual-panel-layout.tsx: the grid classes not found');
  const cellBase = pick(panel, /<div className=\{cn\('([^']+)', contentClassName\)\}>/, 'contextual-panel-layout.tsx: the content cell');
  return {
    wrapper: `${pick(sidebar, /"(group\/sidebar-wrapper [^"]+)"/, 'sidebar.tsx: the provider wrapper')} ${pick(shell, /<SidebarProvider className="([^"]+)"/, 'dashboard-shell.tsx: SidebarProvider className')}`,
    peer: pick(sidebar, /className="(group peer [^"]+)"\s*data-state=\{state\}/, 'sidebar.tsx: the sidebar peer'),
    inset: `${pick(sidebar, /data-slot="sidebar-inset"\s*className=\{cn\(\s*"([^"]+)"/, 'sidebar.tsx: the inset main')} ${pick(shell, /<SidebarInset className="([^"]+)"/, 'dashboard-shell.tsx: SidebarInset className')}`,
    scroller: pick(shell, /<div ref=\{setRef\} className="([^"]+)"/, 'dashboard-shell.tsx: the shell scroller'),
    // ContextualPanelLayout between the scroller and the page: its grid (no inline panel) and its content cell — without them the
    // anchored column is a flex item of the scroller and shrinks to fit, hiding the overflow (a first draft of this spec did)
    grid: `${gridBase} ${gridCols} ${pick(shell, /className="([^"]+)"\s*inlineColumnsClassName=/, 'dashboard-shell.tsx: ContextualPanelLayout className')}`,
    content: `${cellBase} ${pick(shell, /contentClassName=\{cn\(\s*'([^']+)'/, 'dashboard-shell.tsx: ContextualPanelLayout contentClassName')}`,
    topBar: pick(read('components/nav/top-bar.tsx'), /'(@container flex h-12 [^']+)'/, 'top-bar.tsx: the TopBar'),
    anchor: pick(read('app/(authenticated)/chats/layout.tsx'), /<div className="([^"]*h-\[calc\(100svh-var\(--shell-chrome-h\)\)\][^"]*)">/, 'chats/layout.tsx: the anchored column'),
  };
}

async function css(classes: string[]): Promise<string> {
  const compiler = await compile(readFileSync(path.join(APP, 'globals.css'), 'utf8'), { base: APP, onDependency: () => {} });
  return (optimize as unknown as (c: string, o?: object) => { code: string })(compiler.build(classes), { minify: false }).code;
}

/** the shell as dashboard-shell renders it around an anchored page; the page's own content is taller than the screen */
async function shell(page: import('@playwright/test').Page, opts: { width: number; height: number; topBar: boolean }) {
  const c = classesFromSource();
  const all = Object.values(c).join(' ').split(/\s+/).filter(Boolean);
  await page.setViewportSize({ width: opts.width, height: opts.height });
  await page.setContent(`<!doctype html><html><head><style>html,body{margin:0}${await css(all)}</style></head><body>
    <div class="${c.wrapper}" ${opts.topBar ? '' : 'data-topbar-hidden'}>
      <div class="${c.peer}" data-state="expanded" data-collapsible="" data-variant="inset" data-side="left"><div style="width:256px"></div></div>
      <main id="inset" class="${c.inset}">
        <div id="scroller" class="${c.scroller}">
          ${opts.topBar ? `<div id="topbar" class="${c.topBar}">TopBar</div>` : ''}
          <div class="${c.grid}"><div class="${c.content}">
            <div id="anchor" class="${c.anchor}"><div style="overflow-y:auto;flex:1"><div id="strip" style="height:59px">strip</div><div style="height:3000px">messages</div></div></div>
          </div></div>
        </div>
      </main>
    </div></body></html>`);
  return page.evaluate(() => {
    const s = document.getElementById('scroller')!;
    const m = getComputedStyle(document.getElementById('inset')!);
    return { over: s.scrollHeight - s.clientHeight, insetMarginY: parseFloat(m.marginTop) + parseFloat(m.marginBottom),
      stripTop: Math.round(document.getElementById('strip')!.getBoundingClientRect().top),
      topBarBottom: Math.round(document.getElementById('topbar')?.getBoundingClientRect().bottom ?? NaN) };
  });
}

for (const [width, height] of [[1440, 900], [1024, 768]] as const) {
  test(`[SID:4534] lg ${width}×${height} with the TopBar: the inset main has its margin and the shell scroller does not overflow — the strip sits right under the TopBar`, async ({ page }) => {
    const m = await shell(page, { width, height, topBar: true });
    expect(m.insetMarginY, 'the inset margin is on (else this measures nothing)').toBeGreaterThan(0);
    expect(m.over).toBe(0);
    expect(m.stripTop).toBe(m.topBarBottom);
  });

  test(`[SID:4534] lg ${width}×${height} without the TopBar (settings): no overflow`, async ({ page }) => {
    const m = await shell(page, { width, height, topBar: false });
    expect(m.insetMarginY).toBeGreaterThan(0);
    expect(m.over).toBe(0);
  });
}

test('[SID:4534] below lg (390×844): no inset margin and no overflow — the tab-bar values are untouched', async ({ page }) => {
  const m = await shell(page, { width: 390, height: 844, topBar: true });
  expect(m.insetMarginY).toBe(0);
  expect(m.over).toBeLessThanOrEqual(0);
});
