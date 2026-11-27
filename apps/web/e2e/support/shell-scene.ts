import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { test, type Locator, type Page } from '@playwright/test';

/**
 * Shared by the layout specs that draw a screen INSIDE the shell's own class chain (story 5031): home-settings-5c.5031 and states.5031.
 *  · `read` / `pick` / `shellClasses` — the shell's wrapper · list-column gap · inset · scroller · grid · content cell, READ FROM the sources (sidebar.tsx · dashboard-shell.tsx · contextual-panel-layout.tsx), so a change there is what is measured.
 *  · `outDir` / `frames` / `shot` — the capture (CAPTURE_OUT or the test's output folder; the shape of onboarding.5036.states.layout.spec.ts, which keeps its own copy: it is another lane's spec).
 */
const WEB = path.join(__dirname, '..', '..');
const SRC = path.join(WEB, 'src');
export const read = (rel: string) => readFileSync(path.join(SRC, rel), 'utf8');
export const pick = (src: string, re: RegExp, what: string) => { const m = re.exec(src); if (!m) throw new Error(`${what} not found`); return m[1]!; };

export function shellClasses() {
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

/** the capture folder: CAPTURE_OUT when set, else the test's own output folder */
export const outDir = () => { const d = process.env['CAPTURE_OUT'] || test.info().outputDir; mkdirSync(d, { recursive: true }); return d; };
export const frames = (page: Page) => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(1)))));
export async function shot(page: Page, target: Locator | Page, name: string) {
  await page.mouse.move(0, 0);
  await frames(page);
  await target.screenshot({ path: path.join(outDir(), `${name}.png`) });
}
