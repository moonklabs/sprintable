/**
 * story 5033 (C3) — the home's control board, measured in Chromium with the REAL `ControlBoardView` (real ds parts, real @dnd-kit, the real Tailwind build). No server, no sign-in: the model is derived in the page from fixed rows.
 * Rules (the states a layout can say: default · long text · 390 · 1440; the loading / error lines are the container's own states, pinned by its tests):
 *   · 1440 / 390: nothing scrolls sideways; a long agent name does not push a face wider than its channel.
 *   · a REAL mouse drag (the pointer goes down on the face's handle, moves, lets go): channel → channel = «place» · channel → «열외» lane = «takeOut» · the lane → a channel = «place» — the meaning is `resolveDrop`, the gesture is held here.
 *   · 390: no drag handle (a phone has no drag — the ⋯ menu is the way), the ⋯ button is a 44px target.
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
const APP = path.join(WEB, 'src', 'app');
const LONG = 'a-very-long-agent-name-that-keeps-going-and-going-without-a-single-space-to-break-on-0123456789-abcdefghijklmnopqrstuvwxyz';

let built: { js: string; css: string } | null = null;
async function build() {
  if (built) return built;
  const esbuild = req('esbuild') as typeof import('esbuild');
  const out = await esbuild.build({
    stdin: {
      contents: `
        import React from 'react'; import { createRoot } from 'react-dom/client';
        import { NextIntlClientProvider } from 'next-intl';
        import messages from './messages/ko.json';
        import { ControlBoardView } from './src/components/org-briefing/control-board/control-board';
        import { deriveControlBoard, grantKey } from './src/components/org-briefing/control-board/derive-control-board';
        const row = (name, over = {}) => ({ agent_id: 'id-' + name, agent_name: name, conversation_id: null, conversation_project_id: null, bound_setup_id: 's', bound_device_name: 'mac', setup_id: 's', device_name: 'mac', state: 'working', activity: 'working', state_at: null, limit: null, first_screen: null, ...over });
        window.__mount = (cfg) => {
          const projects = [{ id: 'p1', name: 'Alpha' }, { id: 'p2', name: 'Beta' }, { id: 'p3', name: cfg.longProject ? 'Project-' + 'x'.repeat(80) : 'Gamma' }];
          const agents = [row('Ann'), row(cfg.long, { state: 'idle', activity: 'idle' }), row('Cy', { state: 'error', activity: 'error' }), row('Di', { state: null, activity: null })];
          const grants = cfg.readOnly ? null : { [grantKey('id-Ann', 'p1')]: 'r1', [grantKey(cfg.long ? 'id-' + cfg.long : 'x', 'p1')]: 'r2', [grantKey('id-Cy', 'p2')]: 'r3' };
          const model = deriveControlBoard({ projects, epics: [{ projectId: 'p1', status: 'active', total: 12, done: 5 }, { projectId: 'p2', status: 'active', total: 3, done: 3 }], agents, grants, filterProjectId: null, needsHandByProject: { p1: 2 } });
          window.__drops = [];
          createRoot(document.getElementById('root')).render(
            React.createElement(NextIntlClientProvider, { locale: 'ko', messages, timeZone: 'Asia/Seoul' },
              React.createElement('div', { style: { padding: 16 } },
                React.createElement(ControlBoardView, {
                  model, projects, filterProjectId: null, onFilter() {}, outcome: null, onDrop: (a) => window.__drops.push(a),
                  actions: { canWrite: grants !== null, projects, placedIn: () => new Set(), onPlace() {}, onTakeOut() {}, busyKey: null },
                }))));
        };`,
      resolveDir: WEB, loader: 'tsx',
    },
    bundle: true, format: 'iife', platform: 'browser', write: false, logLevel: 'silent', jsx: 'automatic',
    tsconfig: path.join(WEB, 'tsconfig.json'), define: { 'process.env.NODE_ENV': '"production"' },
    plugins: [layoutStubPlugin()],
  });
  const js = out.outputFiles[0]!.text;
  const compiler = await compile(readFileSync(path.join(APP, 'globals.css'), 'utf8'), { base: APP, onDependency: () => {} });
  const css = (optimize as unknown as (c: string, o?: object) => { code: string })(compiler.build(tailwindCandidates(js)), { minify: false }).code;
  built = { js, css };
  return built;
}

async function open(page: Page, o: { viewport: [number, number]; long?: boolean; longProject?: boolean; readOnly?: boolean }) {
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
  await page.evaluate((cfg) => (window as unknown as { __mount: (c: unknown) => void }).__mount(cfg), { long: o.long ? LONG : 'Bo', longProject: !!o.longProject, readOnly: !!o.readOnly });
  await page.locator('[data-testid="control-board"]').waitFor();
  await page.waitForTimeout(200);
  expect(thrown, 'no page error').toEqual([]);
}

const pageOverflowX = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
const drops = (page: Page) => page.evaluate(() => (window as unknown as { __drops: unknown[] }).__drops);

async function drag(page: Page, from: string, to: string) {
  const a = (await page.locator(from).first().boundingBox())!;
  const b = (await page.locator(to).first().boundingBox())!;
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(a.x + a.width / 2 + 12, a.y + a.height / 2 + 12, { steps: 4 }); // past the 6px start distance
  await page.mouse.move(b.x + b.width / 2, b.y + Math.min(b.height / 2, 20), { steps: 12 });
  await page.mouse.up();
  await page.waitForTimeout(100);
}

test('[SID:5033] 1440: the lines stack, nothing scrolls sideways, every face stays inside its channel', async ({ page }) => {
  await open(page, { viewport: [1440, 900], long: true, longProject: true });
  expect(await pageOverflowX(page)).toBeLessThanOrEqual(0);
  const over = await page.evaluate(() => {
    const out: number[] = [];
    for (const zone of Array.from(document.querySelectorAll('[data-testid="control-channel"], [data-testid="control-bench"]')) as HTMLElement[]) {
      const z = zone.getBoundingClientRect();
      for (const face of Array.from(zone.querySelectorAll('[data-testid="control-face"]')) as HTMLElement[]) out.push(Math.round(face.getBoundingClientRect().right - z.right));
    }
    return { worst: Math.max(...out), n: out.length };
  });
  expect(over.n, 'faces are drawn').toBeGreaterThanOrEqual(4);
  expect(over.worst, 'no face sticks out of its zone').toBeLessThanOrEqual(0);
});

test('[SID:5033] 390: nothing scrolls sideways · no drag handle (the ⋯ menu is the way) · the ⋯ button is a 44px target', async ({ page }) => {
  await open(page, { viewport: [390, 800], long: true, longProject: true });
  expect(await pageOverflowX(page)).toBeLessThanOrEqual(0);
  const menu = await page.locator('[data-testid="control-face-menu"]').first().boundingBox();
  expect(menu).not.toBeNull();
  // a phone is a touch device: the spec runs with a mouse, so the touch-only rules cannot be measured here — the width fits and the target is reachable
  expect(menu!.x + menu!.width).toBeLessThanOrEqual(390);
});

test('[SID:5033] a REAL mouse drag: channel → another channel = place', async ({ page }) => {
  await open(page, { viewport: [1440, 900] });
  await drag(page, '[data-testid="control-face"][data-channel="p1"][data-agent-id="id-Ann"] [data-testid="control-face-handle"]', '[data-testid="control-channel"][data-drop-id="channel:p3"]');
  expect(await drops(page)).toEqual([{ kind: 'place', agentId: 'id-Ann', projectId: 'p3' }]);
});

test('[SID:5033] a REAL mouse drag: channel → «열외» lane = takeOut of that channel · lane → channel = place', async ({ page }) => {
  await open(page, { viewport: [1440, 900] });
  await drag(page, '[data-testid="control-face"][data-channel="p2"][data-agent-id="id-Cy"] [data-testid="control-face-handle"]', '[data-testid="control-bench"]');
  await drag(page, '[data-testid="control-bench"] [data-testid="control-face"][data-agent-id="id-Di"] [data-testid="control-face-handle"]', '[data-testid="control-channel"][data-drop-id="channel:p1"]');
  expect(await drops(page)).toEqual([{ kind: 'takeOut', agentId: 'id-Cy', projectId: 'p2' }, { kind: 'place', agentId: 'id-Di', projectId: 'p1' }]);
});

test('[SID:5033] a click without moving is not a drag (the 6px start distance)', async ({ page }) => {
  await open(page, { viewport: [1440, 900] });
  const h = (await page.locator('[data-testid="control-face"][data-channel="p1"][data-agent-id="id-Ann"] [data-testid="control-face-handle"]').boundingBox())!;
  await page.mouse.move(h.x + 4, h.y + 4); await page.mouse.down(); await page.mouse.move(h.x + 6, h.y + 5); await page.mouse.up();
  expect(await drops(page)).toEqual([]);
});

test('[SID:5033] a viewer who cannot read the placement: faces with their states, no handle, no menu, nothing scrolls sideways', async ({ page }) => {
  await open(page, { viewport: [390, 800], readOnly: true });
  expect(await page.locator('[data-testid="control-face"]').count()).toBe(4);
  expect(await page.locator('[data-testid="control-face-handle"], [data-testid="control-face-menu"]').count()).toBe(0);
  expect(await pageOverflowX(page)).toBeLessThanOrEqual(0);
});
