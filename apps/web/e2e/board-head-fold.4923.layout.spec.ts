/**
 * story 4923 — the board head on a small Mac window, measured in Chromium with the REAL fold hook + the REAL «거르기 · n» button / popover (bundled here with esbuild, not copied) and the REAL head class string read from kanban-board.tsx.
 * Before (dev 11-13): the three groups (lens ladder 241 + filters 460 + view switch 259 ≈ 985 px) did not fit a 748 px head and wrapped to 3 rows (123 px; first card y 344 on a 1100×420 window).
 * Rule: when the three groups do not fit the head width, the filters fold into one button → the head is ONE row; on a low window (height ≤ 520) that row is at most 40 px; a roomy head (1088) stays unfolded and one row;
 * the popover holds every filter control, stays inside the window and its Esc closes it with the focus back on the button. No server and no sign-in — the page is made here.
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

const headClass = (): string => {
  const src = readFileSync(path.join(WEB, 'src', 'components', 'kanban', 'kanban-board.tsx'), 'utf8');
  const m = src.match(/const BOARD_HEAD_CLASS = '([^']+)'/);
  if (!m) throw new Error('BOARD_HEAD_CLASS not found');
  return m[1]!;
};
const frameClass = (): string => {
  const src = readFileSync(path.join(WEB, 'src', 'app', '(authenticated)', '[ws]', '[proj]', 'flow', 'flow-client.tsx'), 'utf8');
  const m = src.match(/className="(h-\[calc\(100svh-var\(--shell-chrome-h\)-var\(--work-tabs-h,0px\)\)\][^"]*)" data-testid="flow-board-frame"/);
  if (!m) throw new Error('flow board frame class not found');
  return m[1]!;
};

let built: { js: string; css: string } | null = null;
async function build() {
  if (built) return built;
  const esbuild = req('esbuild') as typeof import('esbuild');
  const HEAD = JSON.stringify(headClass());
  const out = await esbuild.build({
    stdin: {
      contents: `
        import React, { useRef } from 'react'; import { createRoot } from 'react-dom/client';
        import { HeadFilterFold, useHeadFold } from './src/components/kanban/board-head-fold';
        import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from './src/components/ui/dropdown-menu';
        const box = (w, h) => ({ width: w, height: h, flexShrink: 0 });
        function Head({ width }) {
          const ref = useRef(null);
          const hook = useHeadFold(ref, 'k');
          const folded = window.__noFold ? false : hook; // the reproduction of the old head: the filters never fold
          return React.createElement('div', { style: { width } },
            React.createElement('div', { ref, 'data-testid': 'board-head', className: ${HEAD} },
              React.createElement('div', { 'data-testid': 'lens-lead', style: box(241, 34) }, 'ladder'),
              React.createElement('div', { className: 'h-5 w-px shrink-0 bg-border/80', 'aria-hidden': 'true' }),
              React.createElement(HeadFilterFold, { folded, count: 2, label: '거르기', labelActive: '거르기 · 2', popoverLabel: '거르기 조건' },
                React.createElement('div', { style: { display: 'flex', gap: 4, alignItems: 'center', flexWrap: 'nowrap', width: 460 } }, // the real filter group is 460px wide on dev (tabs · dividers · chips)
                  ['전체', '멤버', '에이전트', '전체 스프린트', '전체 목표', '전체 담당자'].map((l, i) => {
                    const style = { height: 28, width: [47, 47, 67, 99, 78, 89][i], flexShrink: 0 };
                    // the three chips are REAL DropdownMenus (the board's own part), as on the board; the tabs are plain buttons
                    if (i < 3) return React.createElement('button', { key: l, type: 'button', 'data-testid': 'ctl-' + i, style }, l);
                    return React.createElement(DropdownMenu, { key: l },
                      React.createElement(DropdownMenuTrigger, { render: React.createElement('button', { type: 'button', 'data-testid': 'ctl-' + i, style }) }, l),
                      React.createElement(DropdownMenuContent, { align: 'start' },
                        React.createElement(DropdownMenuItem, { 'data-testid': 'item-' + i + '-a' }, l + ' A'),
                        React.createElement(DropdownMenuItem, { 'data-testid': 'item-' + i + '-b' }, l + ' B')));
                  }))),
              React.createElement('div', { className: 'ml-auto flex shrink-0 items-center gap-1', style: box(259, 30) }, 'view')));
        }
        window.__mountHead = (width) => createRoot(document.getElementById('root')).render(React.createElement(Head, { width }));`,
      resolveDir: WEB, loader: 'tsx',
    },
    bundle: true, format: 'iife', platform: 'browser', write: false, logLevel: 'silent', jsx: 'automatic',
    tsconfig: path.join(WEB, 'tsconfig.json'), define: { 'process.env.NODE_ENV': '"production"' },
    plugins: [layoutStubPlugin()],
  });
  const js = out.outputFiles[0]!.text;
  const flat = js.replace(/\$\{[^}]*\}/g, ' ');
  const candidates = [...new Set([...flat.matchAll(/[`"']([^`"'\n]+)[`"']/g)].flatMap((m) => m[1]!.split(/\s+/)).filter(Boolean))];
  const compiler = await compile(readFileSync(path.join(APP, 'globals.css'), 'utf8'), { base: APP, onDependency: () => {} });
  const css = (optimize as unknown as (c: string, o?: object) => { code: string })(compiler.build(candidates), { minify: false }).code;
  built = { js, css };
  return built;
}

async function open(page: Page, o: { viewport: [number, number]; headWidth: number }) {
  const { js, css } = await build();
  await page.setViewportSize({ width: o.viewport[0], height: o.viewport[1] });
  await page.route('http://preview.test/**', (route) => route.fulfill({
    contentType: 'text/html',
    body: `<!doctype html><html lang="ko"><head><meta charset="utf-8"><style>${css}</style></head><body class="bg-ds-background text-ds-ink"><div id="root"></div></body></html>`,
  }));
  await page.goto('http://preview.test/');
  const thrown: string[] = [];
  page.on('pageerror', (e) => thrown.push(e.message));
  await page.addScriptTag({ content: js });
  await page.evaluate((w) => (window as unknown as { __mountHead: (w: number) => void }).__mountHead(w), o.headWidth);
  await page.locator('[data-testid="board-head"]').waitFor();
  await page.waitForTimeout(200); // the fold measures in a layout effect and settles after one resize pass
  expect(thrown, 'no page error').toEqual([]);
}

const measure = (page: Page) => page.evaluate(() => {
  const head = document.querySelector('[data-testid="board-head"]') as HTMLElement;
  const kids = Array.from(head.children) as HTMLElement[];
  // rows = clusters of vertical centres (children are centred in their row, so their tops differ by height but their centres do not): two centres closer than 8px are the same row
  const centres = kids.filter((k) => k.getBoundingClientRect().height > 0).map((k) => k.getBoundingClientRect().top + k.getBoundingClientRect().height / 2).sort((a, b) => a - b);
  const rows = centres.reduce<number[]>((acc, c) => (acc.length && c - acc[acc.length - 1]! < 8 ? acc : [...acc, c]), []).length;
  return {
    h: Math.round(head.getBoundingClientRect().height), w: Math.round(head.getBoundingClientRect().width), rows,
    folded: (document.querySelector('[data-slot="board-head-filters"]') as HTMLElement).getAttribute('data-folded'),
    scrollW: head.scrollWidth - head.clientWidth,
  };
});

// the window sizes of the story: Mac app minimum 1100×420 (head 748), 1280×520 (head 928), 1440×900 (head 1088), and 1100×800 (head 748 — a tall window)
const CASES: Array<{ viewport: [number, number]; headWidth: number; folded: boolean; maxH: number }> = [
  { viewport: [1100, 420], headWidth: 748, folded: true, maxH: 40 },
  { viewport: [1280, 520], headWidth: 928, folded: true, maxH: 40 },
  { viewport: [1440, 900], headWidth: 1088, folded: false, maxH: 52 },
  { viewport: [1100, 800], headWidth: 748, folded: true, maxH: 52 },
];
for (const c of CASES) {
  test(`[SID:4923] head ${c.headWidth}px · window ${c.viewport.join('×')}: ${c.folded ? 'the filters fold into one button' : 'stays unfolded'} and the head is ONE row ≤ ${c.maxH}px · no horizontal scroll`, async ({ page }) => {
    await open(page, c);
    const m = await measure(page);
    expect(m.folded).toBe(String(c.folded));
    expect(m.rows, `one row (head ${m.h}px)`).toBe(1);
    expect(m.h, `head height ${m.h}`).toBeLessThanOrEqual(c.maxH);
    expect(m.scrollW, 'the head does not scroll sideways on a desktop window').toBeLessThanOrEqual(0);
  });
}

test('[SID:4923] reproduction: WITHOUT the fold the same head wraps to 3 rows (≥ 100px here, 123px on dev with the real chips) at 748px — and the fold removes exactly that', async ({ page }) => {
  await page.addInitScript(() => { (window as unknown as { __noFold: boolean }).__noFold = true; });
  await open(page, { viewport: [1100, 420], headWidth: 748 });
  const old = await measure(page);
  expect(old.folded).toBe('false');
  expect(old.rows, 'old head: three rows').toBe(3);
  expect(old.h, `old head height ${old.h}`).toBeGreaterThanOrEqual(100); // the stub's chips are plain boxes (113px); the real ones made 123px on dev
});

test('[SID:4923] the popover holds every filter control, stays inside a 1100×420 window, and Esc closes it with the focus back on the button', async ({ page }) => {
  await open(page, { viewport: [1100, 420], headWidth: 748 });
  const trigger = page.locator('[data-testid="board-filter-fold"]');
  await expect(trigger).toHaveText('거르기 · 2');
  await trigger.click();
  const pop = page.locator('[data-slot="board-filter-popover"]');
  await expect(pop).toBeVisible();
  for (let i = 0; i < 6; i += 1) await expect(pop.locator(`[data-testid="ctl-${i}"]`)).toBeVisible();
  const box = (await pop.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.y + box.height, 'the popover ends inside the window').toBeLessThanOrEqual(420);
  expect(box.x + box.width).toBeLessThanOrEqual(1100);
  await page.keyboard.press('Escape');
  await expect(pop).toBeHidden();
  await expect(trigger).toBeFocused();
});

test('[SID:4923] a filter MENU opens from inside the popover without closing it (mouse): the menu is on top, the popover stays, picking an item closes only the menu', async ({ page }) => {
  await open(page, { viewport: [1100, 420], headWidth: 748 });
  await page.locator('[data-testid="board-filter-fold"]').click();
  const pop = page.locator('[data-slot="board-filter-popover"]');
  await expect(pop).toBeVisible();
  await pop.locator('[data-testid="ctl-3"]').click();
  const menu = page.locator('[data-slot="dropdown-menu-content"]');
  await expect(menu, 'the sprint menu opened').toBeVisible();
  await expect(pop, 'the popover is still open while its menu is open').toBeVisible();
  await menu.locator('[data-testid="item-3-b"]').click();
  await expect(menu, 'picking an item closes the menu').toBeHidden();
  await expect(pop, 'the popover stays open after a pick (more filters can follow)').toBeVisible();
});

test('[SID:4923] a filter MENU opens from the popover by keyboard: Esc closes the menu first (focus back on its chip), the next Esc closes the popover (focus back on the fold button)', async ({ page }) => {
  await open(page, { viewport: [1100, 420], headWidth: 748 });
  const trigger = page.locator('[data-testid="board-filter-fold"]');
  await trigger.focus();
  await page.keyboard.press('Enter');
  const pop = page.locator('[data-slot="board-filter-popover"]');
  await expect(pop).toBeVisible();
  const chip = pop.locator('[data-testid="ctl-3"]');
  await chip.focus();
  await page.keyboard.press('Enter');
  const menu = page.locator('[data-slot="dropdown-menu-content"]');
  await expect(menu, 'the menu opens by keyboard from inside the popover').toBeVisible();
  await expect(pop, 'the popover stays open while the menu is open').toBeVisible();
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
  await expect(pop, 'the first Esc closed only the menu').toBeVisible();
  await expect(chip, 'focus is back on the chip that opened the menu').toBeFocused();
  await page.keyboard.press('Escape');
  await expect(pop).toBeHidden();
  await expect(trigger).toBeFocused();
});

test('[SID:4923] the board frame keeps 8px above and below on a low window (16px on a tall one) — the frame class that carries the rule', () => {
  const cls = frameClass();
  expect(cls).toContain('py-4');
  expect(cls).toContain('lg:[@media(max-height:520px)]:py-2');
});
