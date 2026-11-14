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
          root.render(intl(React.createElement('div', { className: 'dashboard-shell-root flex h-screen flex-col' },
            React.createElement('div', { id: 'pane', className: 'flex flex-1 min-h-0 flex-col overflow-y-auto pb-[var(--shell-launcher-clear,0px)]' },
              React.createElement('div', { className: 'mx-auto w-full max-w-4xl space-y-6 p-4 lg:p-6' },
                React.createElement('h1', { className: 'text-lg font-semibold text-ds-ink' }, '홈'),
                React.createElement(Card, { id: 'card-1', title: '내 손이 필요해요', h: 460 }),
                React.createElement(Card, { id: 'card-2', title: '에이전트 상태', h: 360 }),
                React.createElement(Card, { id: 'card-3', title: '오늘 결과', h: 240 }),
                React.createElement(InstructionStrip, { autoFocus: false }))))));
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

async function open(page: Page, vp: { width: number; height: number }, launcher: boolean) {
  const { js, css } = await build();
  await page.setViewportSize(vp);
  await page.unrouteAll();
  await page.route('http://preview.test/**', (route) => route.fulfill({
    contentType: 'text/html',
    body: `<!doctype html><html lang="ko" ${launcher ? 'data-support-launcher' : ''}><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head><body class="bg-ds-background text-ds-ink"><div id="root"></div></body></html>`,
  }));
  const thrown: string[] = [];
  page.on('pageerror', (e) => thrown.push(e.message));
  await page.addInitScript(() => { (window as unknown as { process: unknown }).process = { env: {} }; });
  await page.goto('about:blank');
  await page.goto('http://preview.test/');
  await page.addScriptTag({ content: js });
  await page.evaluate(() => (window as unknown as { __mount: () => void }).__mount());
  await page.waitForTimeout(800);
  if (await page.evaluate(() => document.getElementById('root')!.childElementCount === 0)) throw new Error(`nothing drawn — page errors: ${thrown.join(' | ') || 'none'}`);
}

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
  return {
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
