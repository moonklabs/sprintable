/**
 * story 4906 (lap 3 · PO 11-14, dev c8ababa4a) — the home's instruction strip stands on the body pane's BOTTOM EDGE, opaque, with nothing showing through below it.
 * The REAL strip (components/org-briefing/instruction-strip.tsx) is bundled with esbuild and mounted as the last child of a pane built like dashboard-shell's scroller
 * (`flex flex-1 min-h-0 flex-col overflow-y-auto pb-[var(--shell-launcher-clear)]`) on the real Tailwind build and the real `:root[data-support-launcher] .dashboard-shell-root` rule.
 * Before (measured): the pane's bottom padding (4rem + safe area, kept free for the round support button) stopped the sticky strip 64 px above the pane's edge — the cards scrolled by in that
 * band, on a phone the last card showed UNDER the strip with its title hidden behind it (read order strip → card; the desktop's is card → strip).
 * Rule: at the top AND at the bottom of the scroll, at 1440 × 900 and 390 × 844, with the support button drawn and without it —
 *   · the strip's bottom edge is the pane's bottom edge (gap 0) · no point inside the strip shows anything but the strip itself (0 px of content below its top edge shows through) ·
 *   · the strip's face is opaque · one `ds-line` rule on its top edge · the last card clears the strip with room (≥ 16 px) when scrolled to the end ·
 *   · the send button is the ds Button (primary, 28 px tall; a press on a phone is ≥ 44) and the box is the ds Input.
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

let built: { js: string; css: string } | null = null;
async function build() {
  if (built) return built;
  const esbuild = req('esbuild') as typeof import('esbuild');
  const out = await esbuild.build({
    stdin: {
      contents: `
        import React from 'react'; import { createRoot } from 'react-dom/client'; import { NextIntlClientProvider } from 'next-intl';
        import ko from './messages/ko.json';
        import { InstructionStrip } from './src/components/org-briefing/instruction-strip';
        const intl = (child) => React.createElement(NextIntlClientProvider, { locale: 'ko', messages: ko, timeZone: 'Asia/Seoul' }, child);
        // the pane of dashboard-shell.tsx: the body's root div is \`mx-auto w-full max-w-4xl space-y-6 p-4 lg:p-6\` and the strip is its last child
        const Card = (p) => React.createElement('div', { 'data-testid': p.id, className: 'rounded-ds-panel border border-ds-line bg-ds-surface p-4', style: { height: p.h } }, React.createElement('h2', { className: 'text-ds-body font-semibold text-ds-ink' }, p.title), React.createElement('p', { className: 'text-ds-small text-ds-ink-2' }, 'card body text'));
        window.__mount = () => {
          const root = createRoot(document.getElementById('root'));
          root.render(intl(React.createElement('div', { className: 'dashboard-shell-root flex h-screen' },
            window.__side ? React.createElement('div', { 'data-testid': 'side', style: { width: window.__side, flex: 'none' }, className: 'border-r border-ds-line' }) : null,
            React.createElement('div', { className: 'flex min-w-0 flex-1 flex-col' },
            React.createElement('div', { id: 'pane', className: 'flex flex-1 min-h-0 flex-col overflow-y-auto pb-[var(--shell-launcher-clear,0px)]' },
              React.createElement('div', { className: 'mx-auto w-full max-w-4xl space-y-6 p-4 lg:p-6' },
                React.createElement('h1', { className: 'text-lg font-semibold text-ds-ink' }, '홈'),
                React.createElement(Card, { id: 'card-1', title: '내 손이 필요해요', h: 460 }),
                React.createElement(Card, { id: 'card-2', title: '에이전트 상태', h: 360 }),
                React.createElement(Card, { id: 'card-3', title: '오늘 결과', h: 240 }),
                React.createElement(InstructionStrip, { autoFocus: false })))))));
        };`,
      resolveDir: WEB, loader: 'tsx',
    },
    bundle: true, format: 'iife', platform: 'browser', write: false, logLevel: 'silent', jsx: 'automatic',
    tsconfig: path.join(WEB, 'tsconfig.json'),
    define: { 'process.env.NODE_ENV': '"production"' },
    plugins: [layoutStubPlugin()],
  });
  const js = out.outputFiles[0]!.text;
  const compiler = await compile(readFileSync(path.join(APP, 'globals.css'), 'utf8'), { base: APP, onDependency: () => {} });
  // the scene's own classes (not part of the bundled component) are written in the stdin source above, so the bundle's strings carry them
  const css = (optimize as unknown as (c: string, o?: object) => { code: string })(compiler.build(tailwindCandidates(js)), { minify: false }).code;
  built = { js, css };
  return built;
}

async function open(page: Page, vp: { width: number; height: number }, launcher: boolean, opts: { failure?: boolean; side?: number } = {}) {
  const { js, css } = await build();
  await page.setViewportSize(vp);
  await page.unrouteAll();
  await page.route('http://preview.test/**', (route) => {
    const url = new URL(route.request().url());
    // the real send path (lib/today-instruct): the person's conversations hold exactly ONE agent DM, and the server refuses the message → the real failure line is drawn
    if (url.pathname.startsWith('/api/conversations') && route.request().method() === 'GET') return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ data: [{ id: 'dm-1', type: 'dm', participants: [{ member_id: 'me-1', type: 'human' }, { member_id: 'ag-1', type: 'agent' }] }], total: 1 }) });
    if (url.pathname.endsWith('/messages') && route.request().method() === 'POST') return route.fulfill({ status: 500, contentType: 'application/json', body: '{}' });
    if (url.pathname !== '/') return route.fulfill({ status: 404, body: '{}' });
    return route.fulfill({
    contentType: 'text/html',
    body: `<!doctype html><html lang="ko" ${launcher ? 'data-support-launcher' : ''}><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head><body class="bg-ds-background text-ds-ink"><div id="root"></div></body></html>`,
    });
  });
  const thrown: string[] = [];
  page.on('pageerror', (e) => thrown.push(e.message));
  await page.addInitScript(([side, failure]) => {
    const w = window as unknown as { process: unknown; __side?: boolean; __dashboardCtx?: unknown };
    w.process = { env: {} };
    w.__side = side as number; // the app's sidebar (open 312 · folded 56) stands left of the pane from lg: the pane is narrower than the window by that much
    if (failure) w.__dashboardCtx = { projectId: 'proj-1', currentTeamMemberId: 'me-1' };
  }, [opts.side ?? (vp.width >= 1024 ? 312 : 0), !!opts.failure]);
  await page.goto('about:blank');
  await page.goto('http://preview.test/');
  await page.addScriptTag({ content: js });
  await page.evaluate(() => (window as unknown as { __mount: () => void }).__mount());
  await page.waitForTimeout(800);
  if (launcher) await placeButton(page, 0);
  if (await page.evaluate(() => document.getElementById('root')!.childElementCount === 0)) throw new Error(`nothing drawn — page errors: ${thrown.join(' | ') || 'none'}`);
}

/**
 * The round support button's WORST box with `toasts` toast cards stacked under it: BottomDock stacks banner → toasts → button bottom-to-top, so each card lifts the button by its height (≤ 90 px, the dock's own measured
 * range 58–90) + the 8 px gap. At rest the box is the whole band the shell keeps for it (the pane's bottom 4rem · 48 px wide, 16 px off the WINDOW's right edge). Drawn only while the button is (`<html data-support-launcher>`).
 */
const placeButton = (page: Page, toasts: number) => page.evaluate((n) => {
  document.querySelector('[data-testid="launcher-band"]')?.remove();
  const pane = document.getElementById('pane')!.getBoundingClientRect();
  const band = document.createElement('div');
  band.setAttribute('data-testid', 'launcher-band');
  band.style.cssText = `position:fixed;left:${innerWidth - 16 - 48}px;top:${pane.bottom - 64 - n * (90 + 8)}px;width:48px;height:64px;pointer-events:none`;
  document.body.appendChild(band);
}, toasts);

const measure = (page: Page) => page.evaluate(() => {
  const pane = document.getElementById('pane')!;
  const strip = document.querySelector('[data-testid="today-instruction-strip"]') as HTMLElement;
  const form = document.querySelector('[data-testid="today-instruction-form"]') as HTMLElement;
  const paneBox = pane.getBoundingClientRect(); const stripBox = strip.getBoundingClientRect();
  // every point inside the strip (a grid) must hit the strip itself or something inside it — a card showing through would be hit instead
  let through = 0; let probed = 0;
  for (let y = Math.ceil(stripBox.top) + 1; y < Math.floor(Math.min(stripBox.bottom, paneBox.bottom)) - 1; y += 4) {
    for (const fx of [0.1, 0.5, 0.9]) {
      probed++;
      const hit = document.elementFromPoint(stripBox.left + stripBox.width * fx, y);
      if (!hit || !strip.contains(hit)) through++;
    }
  }
  const cards = ['card-1', 'card-2', 'card-3'].map((id) => { const r = (document.querySelector(`[data-testid="${id}"]`) as HTMLElement).getBoundingClientRect(); return { id, top: Math.round(r.top), bottom: Math.round(r.bottom) }; });
  const last = cards[2]!;
  const cs = getComputedStyle(strip); const fcs = getComputedStyle(form);
  const formClass = form.className;
  const send = [...form.querySelectorAll('button')][0] as HTMLElement;
  const input = form.querySelector('input') as HTMLElement;
  const sb = send.getBoundingClientRect();
  const box = (e: Element | null) => { if (!e) return null; const r = e.getBoundingClientRect(); return { l: Math.round(r.left), t: Math.round(r.top), r: Math.round(r.right), b: Math.round(r.bottom) }; };
  const hit = (a: { l: number; t: number; r: number; b: number } | null, b: { l: number; t: number; r: number; b: number } | null) => !!a && !!b && a.l < b.r && b.l < a.r && a.t < b.b && b.t < a.b;
  const card1 = box(document.querySelector('[data-testid="card-1"]'));
  const column = box(strip.parentElement);
  const inputBox = box(input); const sendBox = box(send); const failEl = document.querySelector('[data-testid="today-instruction-failed"]');
  // the failure line's CONTENT box: its padding-right IS the corner kept free (the text never enters it), so the padded border box would call a kept corner an overlap — and it does whenever the wrapped text is taller than one line (CI's fonts)
  const failRaw = box(failEl);
  const fail = failRaw && failEl ? { ...failRaw, r: failRaw.r - Math.round(parseFloat(getComputedStyle(failEl).paddingRight) || 0) } : null; const band = box(document.querySelector('[data-testid="launcher-band"]'));
  return {
    card1, column, inputBox, sendBox, fail, band, edgeRight: card1 && sendBox ? sendBox.r - card1.r : null, edgeLeft: card1 && inputBox ? inputBox.l - card1.l : null, failEdgeRight: card1 && fail ? fail.r - card1.r : null,
    failPadRight: (() => { const e = document.querySelector('[data-testid="today-instruction-failed"]'); return e ? getComputedStyle(e).paddingRight : null; })(),
    bandHitsInput: hit(band, inputBox), bandHitsSend: hit(band, sendBox), bandHitsFail: hit(band, fail), bandClearAboveRow: band && inputBox ? band.t - Math.max(inputBox.b, sendBox ? sendBox.b : 0) : null, bandClearAboveFail: band && fail ? band.t - fail.b : null,
    paneBottom: Math.round(paneBox.bottom), stripTop: Math.round(stripBox.top), stripBottom: Math.round(stripBox.bottom),
    gapBelowStrip: Math.round(paneBox.bottom - stripBox.bottom), stripInsidePane: stripBox.top >= paneBox.top - 1 && stripBox.bottom <= paneBox.bottom + 1, through, probed,
    formClass, stripBg: cs.backgroundColor, ruleW: fcs.borderTopWidth, ruleStyle: fcs.borderTopStyle, ruleColor: fcs.borderTopColor,
    lastBottom: last.bottom, lastClearance: Math.round(stripBox.top - last.bottom), lastTop: last.top, cards,
    scrollTop: Math.round(pane.scrollTop), scrollMax: pane.scrollHeight - pane.clientHeight,
    sendSlot: send.getAttribute('data-slot'), sendH: Math.round(sb.height), sendW: Math.round(sb.width), inputSlot: input.getAttribute('data-slot'),
    overflowX: document.documentElement.scrollWidth > innerWidth + 1,
  };
});

const SCREENS = [
  { name: '1440 × 900', width: 1440, height: 900, touch: false },
  { name: '1100 × 800 (the Mac app\'s default window · near the lg edge)', width: 1100, height: 800, touch: false },
  { name: '390 × 844 (phone)', width: 390, height: 844, touch: true },
];

for (const scr of SCREENS) {
  for (const launcher of [true, false]) {
    test.describe(`${scr.name} · support button ${launcher ? 'drawn' : 'not drawn'}`, () => {
      test.use({ hasTouch: scr.touch, isMobile: scr.touch });

      test(`[SID:4906] the strip reaches the pane's bottom edge, is opaque, shows nothing through, at the top and at the bottom of the scroll`, async ({ page }) => {
        await open(page, { width: scr.width, height: scr.height }, launcher);
        // top of the scroll: the last card sits under / past the strip
        const top = await measure(page);
        expect(top.scrollTop).toBe(0);
        expect(top.scrollMax, 'the scene scrolls (so both ends are real)').toBeGreaterThan(40);
        expect(Math.abs(top.gapBelowStrip), `top · the strip stands ${top.gapBelowStrip}px off the pane's bottom edge (before: 64 above it)`).toBeLessThanOrEqual(1);
        expect(top.stripInsidePane, 'top · the strip is inside the pane (not pushed out of it)').toBe(true);
        expect(top.probed, 'top · the probe grid sampled the strip').toBeGreaterThan(8);
        expect(top.through, `top · ${top.through} of ${top.probed} points inside the strip show something other than the strip`).toBe(0);
        // bottom of the scroll
        await page.evaluate(() => { const p = document.getElementById('pane')!; p.scrollTop = p.scrollHeight; });
        await page.waitForTimeout(300);
        const bottom = await measure(page);
        expect(bottom.scrollTop).toBeGreaterThan(0);
        expect(Math.abs(bottom.gapBelowStrip), `bottom · the strip stands ${bottom.gapBelowStrip}px off the pane's bottom edge`).toBeLessThanOrEqual(1);
        expect(bottom.stripInsidePane, 'bottom · the strip is inside the pane').toBe(true);
        expect(bottom.probed, 'bottom · the probe grid sampled the strip').toBeGreaterThan(8);
        expect(bottom.through, `bottom · ${bottom.through} of ${bottom.probed} points inside the strip show something other than the strip`).toBe(0);
        expect(bottom.lastClearance, 'scrolled to the end the last card clears the strip with room').toBeGreaterThanOrEqual(16);
        for (const m of [top, bottom]) {
          expect(m.stripBg, 'the strip face is opaque').not.toMatch(/rgba\(\d+, \d+, \d+, 0(\.\d+)?\)|transparent/);
          expect(m.ruleStyle).toBe('solid');
          expect(parseFloat(m.ruleW), 'one rule on the strip\'s top edge').toBeGreaterThanOrEqual(1);
          expect(m.overflowX).toBe(false);
        }
        // the rule is the ds line colour, not the old border token
        const line = await page.evaluate(() => { const probe = document.createElement('i'); probe.className = 'border-ds-line border'; probe.style.cssText = 'position:fixed;left:-9px;top:0;width:1px;height:1px'; document.body.appendChild(probe); const c = getComputedStyle(probe).borderTopColor; probe.remove(); return c; });
        expect(bottom.ruleColor, 'the top rule is ds-line').toBe(line);
        expect(bottom.formClass, 'the rule is spelled with the ds token, not the old border token').toMatch(/(^|\s)border-ds-line(\s|$)/);
        expect(bottom.formClass).not.toMatch(/(^|\s)border-border(\s|$)/);
      });

      test(`[SID:4906] the send button is the ds Button (primary) and the box is the ds Input; the press is ≥ 44 on a phone`, async ({ page }) => {
        await open(page, { width: scr.width, height: scr.height }, launcher);
        const m = await measure(page);
        expect(m.sendSlot, 'the send button is a ds Button (before: the old ui/button)').toBe('ds-button');
        expect(m.inputSlot, 'the box is the ds Input (before: the old ui/input)').toBe('ds-input');
        if (scr.touch) expect(Math.min(m.sendH, m.sendW), 'a phone press is ≥ 44').toBeGreaterThanOrEqual(43.5);
        else expect(m.sendH, 'ds Button md is 28').toBe(28);
      });
    });
  }
}

// ── the corner for the round support button (PO 11-14) ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// BottomDock stacks banner → toasts → button: a toast lifts the button by its height, and on a narrow pane the lifted button sits over the row's right end ([보내기] on a phone · at 1100). So the row keeps its right 56px free
// WHILE THE BUTTON CAN MEET IT, and gives the corner back when the PANE (sidebar open or folded — not the window) is wide enough that the centred, capped column ends before the button's box. Measured here on the real boxes:
// sidebar open / folded × 1100 · 1280 · 1440 (and the phone) × no toast / one / two × top and bottom of the scroll, with the real failure line too.
const GRID = [
  ...[1100, 1280, 1440].flatMap((width) => [{ name: `${width} · sidebar open`, width, height: 800, side: 312, touch: false }, { name: `${width} · sidebar folded`, width, height: 800, side: 56, touch: false }]),
  { name: '390 phone', width: 390, height: 844, side: 0, touch: true },
];

for (const g of GRID) {
  test.describe(`corner · ${g.name}`, () => {
    test.use({ hasTouch: g.touch, isMobile: g.touch });
    for (const withFailure of [false, true]) {
      test(`[SID:4906] ${withFailure ? 'with the real failure line: ' : ''}the support button's box never meets the input · [보내기]${withFailure ? ' · the failure line' : ''} with 0 · 1 · 2 toasts, and the row runs to the cards' edge exactly where the column ends before the button`, async ({ page }) => {
        await open(page, { width: g.width, height: g.height }, true, { side: g.side, failure: withFailure });
        if (withFailure) {
          await page.locator('[data-testid="today-instruction-input"]').fill('릴리스 점검해 줘');
          await page.locator('[data-testid="today-instruction-form"] button').first().click();
          await page.locator('[data-testid="today-instruction-failed"]').waitFor();
        }
        for (const where of ['top', 'bottom'] as const) {
          await page.evaluate((w) => { const p = document.getElementById('pane')!; p.scrollTop = w === 'top' ? 0 : p.scrollHeight; }, where);
          await page.waitForTimeout(250);
          for (const toasts of [0, 1, 2]) {
            await placeButton(page, toasts);
            const m = await measure(page);
            const tag = `${g.name} · ${where} · ${toasts} toast(s)`;
            expect(m.band, `${tag} · the button's box is placed`).not.toBeNull();
            expect(m.bandHitsInput, `${tag} · the button meets the input`).toBe(false);
            expect(m.bandHitsSend, `${tag} · the button meets [보내기]`).toBe(false);
            if (withFailure) expect(m.bandHitsFail, `${tag} · the button meets the failure line`).toBe(false);
            // where the column (the root box, padding included) ends before the button's box, the corner is given back: the row ends at the cards' right edge (±1)
            const columnClear = m.column!.r <= m.band!.l;
            if (columnClear) expect(Math.abs(m.edgeRight!), `${tag} · the column is clear of the button, the row ends ${m.edgeRight}px off the cards' edge`).toBeLessThanOrEqual(1);
            else expect(m.sendBox!.r, `${tag} · the column reaches the button: [보내기] ends at ${m.sendBox!.r}, the button starts at ${m.band!.l}`).toBeLessThanOrEqual(m.band!.l);
            if (withFailure) expect(m.failPadRight === '0px', `${tag} · the failure line keeps its corner exactly when the row does`).toBe(columnClear);
          }
        }
      });
    }
  });
}
