/**
 * story 4941 — the REAL Mac window: the web area is 539 px high, and the app shell's scroller has 64 px of padding under it (`pb-[var(--shell-launcher-clear)]`, dashboard-shell.tsx:296 — the sticky bottom edge of
 * a stuck row sits 64 px above the scroller's bottom) under a 48 px top bar. The 4934 layout spec had neither (nor the phone tick that an account with remote control OFF draws), so a 271 px stuck row that covered
 * «② 이름과 역할» · the name · role fields · «③ 폴더» on the first screen at 539 went unseen (dev b47453275 · 44ba8abe9 measured: row y 196–467, name field 297–333 under it).
 * Now the stuck row is the button + ONE sentence (≈60 px): on the first screen at 539 the name (297–333) and role (365–401) fields stand clear above it, the question is in sight as that sentence
 * (its whole box is one scroll away), and a field that takes the focus comes above the row (scroll-margin). 900 high: nothing is covered. Real DesktopSetupQuick · the real Tailwind build · the real words.
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
const PROJ = '11111111-1111-4111-8111-111111111111';
const CODE = `${'A'.repeat(20)}_-${'b'.repeat(21)}`;
const HASH = `#code=${CODE}&setup=11111111-1111-4111-8111-aaaaaaaaaaaa&runtimes=claude,codex&caps=move,solo&rv=claude:2.1.289,codex:0.159.3&fshown=~/new/folder&fname=folder`;

let built: { js: string; css: string } | null = null;
async function build() {
  if (built) return built;
  const esbuild = req('esbuild') as typeof import('esbuild');
  const out = await esbuild.build({
    stdin: {
      contents: `
        import React from 'react'; import { createRoot } from 'react-dom/client'; import { NextIntlClientProvider } from 'next-intl';
        import ko from './messages/ko.json';
        import { DesktopSetupQuick } from './src/components/desktop/desktop-setup-quick';
        import { parseSetupFragment } from './src/lib/desktop-setup';
        window.__mount = (hash, inner) => {
          const card = React.createElement(NextIntlClientProvider, { locale: 'ko', messages: ko, timeZone: 'Asia/Seoul' },
            React.createElement(DesktopSetupQuick, { query: parseSetupFragment(hash), onTeam: () => {} }));
          // the card sits in the parents the app really has: the page's own padding (the card is p-6 inside a padded main) · an inner scroller when asked
          const page = React.createElement('div', { style: { padding: '24px', maxWidth: '640px', margin: '0 auto' } }, card);
          const topbar = React.createElement('div', { id: 'topbar', style: { height: '48px', flex: 'none' } }, 'top');
          // the page's own wrapper (mx-auto w-full max-w-2xl p-6, desktop/setup/page.tsx) holds the card DIRECTLY - the card is its own bordered p-6 box (no second box around it)
          const wrap = React.createElement('div', { className: 'mx-auto w-full max-w-2xl p-6' }, card);
          // the shell's scroller: flex column · overflow-y auto · 64 px under it (the launcher's clear) - the card sits in it exactly as in the app
          const tree = React.createElement('div', { id: 'scroller', style: { height: 'calc(100vh - 16px)', margin: '8px 0', overflowY: 'auto', display: 'flex', flexDirection: 'column', paddingBottom: '64px' } }, topbar, wrap); // (the shell frame leaves 8 px above and below the scroller: dev measured scrollport y 8–531 in a 539 window)
          createRoot(document.getElementById('root')).render(tree);
        };`,
      resolveDir: WEB, loader: 'tsx',
    },
    bundle: true, format: 'iife', platform: 'browser', write: false, logLevel: 'silent', jsx: 'automatic',
    tsconfig: path.join(WEB, 'tsconfig.json'),
    define: { 'process.env.NODE_ENV': '"production"', 'process.env.NEXT_PUBLIC_APP_URL': '"https://app.sprintable.ai"' },
    plugins: [layoutStubPlugin()],
  });
  const js = out.outputFiles[0]!.text;
  const compiler = await compile(readFileSync(path.join(APP, 'globals.css'), 'utf8'), { base: APP, onDependency: () => {} });
  const css = (optimize as unknown as (c: string, o?: object) => { code: string })(compiler.build(tailwindCandidates(js)), { minify: false }).code;
  built = { js, css };
  return built;
}

async function open(page: Page, win: { w: number; h: number }, o: { inner: boolean; room: boolean; phoneRowOff?: boolean }) {
  const { js, css } = await build();
  await page.setViewportSize({ width: win.w, height: win.h });
  await page.unrouteAll();
  await page.route('http://preview.test/**', async (route) => {
    const url = new URL(route.request().url());
    const json = (body: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head><body><div id="root"></div></body></html>` });
    if (url.pathname === '/api/desktop/recipes') return json({ recipes: [], agent_room: null, project_room: o.room ? { limit: 1, existing_project: { id: PROJ, name: 'Mine' } } : null });
    if (/^\/api\/organizations\/[^/]+\/remote-control$/.test(url.pathname)) return json({ data: { enabled: !o.phoneRowOff, can_change: true, enabled_at: null } });
    if (url.pathname === '/api/desktop/setup-codes/confirm-solo') return json({ error: { code: 'whatever' } }, 500); // a failed press (4941 codex r1: the message stays in the one line)
    return json({}, 404);
  });
  await page.addInitScript(() => {
    (window as unknown as { process: unknown }).process = { env: {} };
    (window as unknown as { __dashboardCtx: unknown }).__dashboardCtx = {
      orgId: 'org-1', projectId: '11111111-1111-4111-8111-111111111111', userName: '김지우',
      orgMemberships: [{ orgId: 'org-1', orgName: 'O', orgSlug: 'o', role: 'owner' }],
      projectMemberships: [{ projectId: '11111111-1111-4111-8111-111111111111', projectName: 'Mine', orgId: 'org-1' }],
    };
  });
  await page.goto('about:blank');
  await page.goto('http://preview.test/');
  await page.addScriptTag({ content: js });
  await page.evaluate(([h, inner]) => (window as unknown as { __mount: (h: string, i: boolean) => void }).__mount(h as string, inner as boolean), [HASH, o.inner] as const);
  await page.locator('[data-testid="quick-start-row"]').waitFor({ timeout: 20_000 });
  if (o.room) await page.locator('[data-testid="quick-limit"]').waitFor({ timeout: 20_000 }); // the plan's answer has come and the question is drawn
  await page.waitForTimeout(300);
}


/** the numbers the PO's candidate was about: where the stuck row is, what it covers, what the point at each field's centre hits */
const geo = (page: Page) => page.evaluate(() => {
  const sc = document.getElementById('scroller')!;
  const row = document.querySelector('[data-testid="quick-start-row"]')!;
  const rr = row.getBoundingClientRect();
  const R = (e: Element | null) => (e ? { top: Math.round(e.getBoundingClientRect().top), bottom: Math.round(e.getBoundingClientRect().bottom) } : null);
  const hit = (e: Element | null) => { if (!e) return null; const r = e.getBoundingClientRect(); const t = document.elementFromPoint((r.left + r.right) / 2, (r.top + r.bottom) / 2); return t ? (row.contains(t) ? 'ROW' : (t === e || e.contains(t) ? 'itself' : t.tagName.toLowerCase())) : null; };
  const name = document.querySelector('[data-testid="quick-agent-name"]'); const role = document.querySelector('[data-testid="quick-agent-role"]');
  const line = document.querySelector('#quick-start-line'); const btn = row.querySelector('button');
  const sr = sc.getBoundingClientRect();
  return { scrollTop: Math.round(sc.scrollTop), max: Math.round(sc.scrollHeight - sc.clientHeight), scrollBottom: Math.round(sr.bottom), row: { top: Math.round(rr.top), bottom: Math.round(rr.bottom), h: Math.round(rr.height) },
    name: R(name), role: R(role), nameHit: hit(name), roleHit: hit(role), line: R(line), lineText: (line?.textContent || '').trim(), btn: R(btn), box: R(document.querySelector('[data-testid="quick-limit"]')), tick: R(document.querySelector('[data-testid="setup-phone-control"]')),
    boxInRow: !!row.querySelector('[data-testid="quick-limit"]'), tickInRow: !!row.querySelector('[data-testid="setup-phone-control"]') };
});

for (const win of [{ w: 1100, h: 539 }, { w: 1440, h: 539 }, { w: 1440, h: 900 }]) {
  test.describe(`4941 the stuck row is one line · ${win.w}×${win.h} · the real shell's scroller (64 px under) · remote control OFF (the tick drawn)`, () => {
    test('first screen: the row is the button + one sentence (≤ 64 px), the name and role fields are clear above it, the question is in sight', async ({ page }) => {
      await open(page, win, { inner: true, room: true, phoneRowOff: true });
      await expect(page.locator('[data-testid="setup-phone-control"]')).toBeVisible();
      if (process.env['SHOT_DIR']) await page.screenshot({ path: `${process.env['SHOT_DIR']}/after-${win.w}x${win.h}-first-screen.png` }); // (the PR's before/after picture — the real Mac window's size; not a check)
      const g = await geo(page);
      expect(g.scrollTop).toBe(0);
      expect(g.row.h, 'the stuck row is the button and one sentence').toBeLessThanOrEqual(66);
      expect(g.boxInRow || g.tickInRow, 'the question\'s box and the phone tick stand in the flow').toBe(false);
      // the button and the sentence beside it are in sight (above the scroller's bottom padding, inside the visible area)
      expect(g.btn!.bottom).toBeLessThanOrEqual(g.scrollBottom);
      expect(g.line!.bottom).toBeLessThanOrEqual(g.scrollBottom);
      expect(g.lineText).toContain('무료 플랜은 프로젝트가 하나예요');
      // the name and role fields: clear above the row on the first screen, and the point at their centre is the field itself
      expect(g.name!.bottom, `${win.w}×${win.h}: name field above the row`).toBeLessThanOrEqual(g.row.top);
      expect(g.role!.bottom, `${win.w}×${win.h}: role field above the row`).toBeLessThanOrEqual(g.row.top);
      expect(g.nameHit).toBe('itself');
      expect(g.roleHit).toBe('itself');
    });

    test('a failed press: the message is the row\'s one sentence (red) — the row stays ≤ 66 px and the name field stays clear', async ({ page }) => {
      await open(page, win, { inner: true, room: false, phoneRowOff: true });
      await page.getByRole('button', { name: '만들기', exact: true }).click();
      await expect(page.locator('[data-testid="quick-error"]')).toBeVisible();
      await page.waitForTimeout(200);
      const g = await geo(page);
      expect(g.row.h, 'the error is the one sentence beside the button').toBeLessThanOrEqual(66);
      expect(g.name!.bottom).toBeLessThanOrEqual(g.row.top);
      expect(g.nameHit).toBe('itself');
    });

    test('a field that takes the focus comes above the row — name · role · «바꾸기» (the folder buttons below the fold)', async ({ page }) => {
      await open(page, win, { inner: true, room: true, phoneRowOff: true });
      for (const sel of ['[data-testid="quick-agent-name"]', '[data-testid="quick-agent-role"]', '[data-testid="quick-folder"] ~ a']) {
        await page.locator(sel).focus();
        await page.waitForTimeout(150);
        const f = await page.evaluate((s) => {
          const el = document.querySelector(s)!; const row = document.querySelector('[data-testid="quick-start-row"]')!; const r = el.getBoundingClientRect(); const rr = row.getBoundingClientRect();
          const t = document.elementFromPoint((r.left + r.right) / 2, (r.top + r.bottom) / 2);
          return { top: Math.round(r.top), bottom: Math.round(r.bottom), rowTop: Math.round(rr.top), hit: t ? (row.contains(t) ? 'ROW' : (t === el || el.contains(t) ? 'itself' : t.tagName.toLowerCase())) : null };
        }, sel);
        expect(f.bottom, `${sel}: above the row after the focus`).toBeLessThanOrEqual(f.rowTop + 1);
        expect(f.hit, `${sel}: the point at its centre is the field`).toBe('itself');
      }
    });
  });
}
