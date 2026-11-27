/**
 * story 5034 (C4) — the chat card, measured in Chromium with the REAL components (bundled with esbuild) and the real Tailwind build of globals.css; nothing is signed in, no server runs.
 * The rule: in every one of its states (default · loading · empty · error · not visible · long text) the card stays inside its column at 390 and at 1440, in light and in dark; a long
 * title is cut at two lines instead of widening the card; the retry button is a ds Button (≥ 44 on touch). The pictures of every state in both themes and both widths go to
 * `~/.sprintable-shared/nwachukwu/5034/shots/` (a plain folder of PNGs — the PO looks at them).
 */
import { mkdirSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { expect, test, type Page } from '@playwright/test';
import { compile, optimize } from '@tailwindcss/node';
import { layoutStubPlugin } from './support/layout-stubs';
import { tailwindCandidates } from './support/tailwind-candidates';

const req = createRequire(__filename);
const WEB = path.join(__dirname, '..');
const APP = path.join(WEB, 'src', 'app');
const SHOTS = path.join(os.homedir(), '.sprintable-shared', 'nwachukwu', '5034', 'shots');

let built: { js: string; css: string } | null = null;
async function build() {
  if (built) return built;
  const esbuild = req('esbuild') as typeof import('esbuild');
  const bodies: Record<string, string> = {
    '@/components/realtime-provider': 'export function useSseMultiplexerContext() { return { subscribe: () => () => {} }; }',
    '@/app/dashboard/dashboard-shell': "export function useDashboardContext() { return { orgId: 'org-1', currentTeamMemberId: 'me-1', projectId: 'p1', role: 'member', currentMemberType: 'human', projectMemberships: [] }; }",
  };
  const filter = new RegExp(`^(${Object.keys(bodies).map((k) => k.replace(/[/.-]/g, '\\$&')).join('|')})$`);
  const out = await esbuild.build({
    stdin: {
      contents: `
        import React from 'react'; import { createRoot } from 'react-dom/client'; import { NextIntlClientProvider } from 'next-intl';
        import ko from './messages/ko.json';
        import { DeliveryChoice, DeliveryTimingLine } from './src/components/chat/delivery-timing';
        const LONG = '아주아주 긴 이름의 에이전트 아주아주 긴 이름의 에이전트';
        window.__mountDelivery = (w) => {
          const h = React.createElement;
          const log = Object.fromEntries([0,1,2,3,4].map((i) => ['agent-' + i, { via: i % 2 ? 'turn' : 'next_turn', at: 'x' }]));
          createRoot(document.getElementById('root')).render(h(NextIntlClientProvider, { locale: 'ko', messages: ko, timeZone: 'Asia/Seoul' },
            h('div', { id: 'col', style: { width: w + 'px', padding: '12px', boxSizing: 'border-box' }, className: 'bg-ds-background' },
              h('div', { 'data-case': 'choice' }, h(DeliveryChoice, { value: 'now', onChange() {}, cannotInterject: [LONG, LONG] })),
              h('div', { 'data-case': 'choice-after' }, h(DeliveryChoice, { value: 'after_turn', onChange() {}, cannotInterject: [LONG] })),
              h('div', { 'data-case': 'line', style: { marginTop: '12px' } }, h(DeliveryTimingLine, { mode: 'after_turn', log, isMine: true, nameOf: (id) => LONG + id })),
              h('div', { 'data-case': 'pending', style: { marginTop: '12px' } }, h(DeliveryTimingLine, { mode: 'after_turn', log: undefined, isMine: true, nameOf: () => LONG })))));
        };`,
      resolveDir: WEB, loader: 'tsx',
    },
    bundle: true, format: 'iife', platform: 'browser', write: false, logLevel: 'silent', jsx: 'automatic',
    tsconfig: path.join(WEB, 'tsconfig.json'),
    define: { 'process.env.NODE_ENV': '"production"', 'process.env.NEXT_PUBLIC_APP_URL': '"https://app.sprintable.ai"' },
    plugins: [
      { name: 'cards-5034-stubs', setup(b) {
        b.onResolve({ filter }, (a) => ({ path: a.path, namespace: 'cards5034' }));
        b.onLoad({ filter: /.*/, namespace: 'cards5034' }, (a) => ({ contents: bodies[a.path]!, loader: 'js', resolveDir: WEB }));
      } },
      layoutStubPlugin(),
    ],
  });
  const js = out.outputFiles[0]!.text;
  const candidates = tailwindCandidates(js);
  const compiler = await compile(readFileSync(path.join(APP, 'globals.css'), 'utf8'), { base: APP, onDependency: () => {} });
  const css = (optimize as unknown as (c: string, o?: object) => { code: string })(compiler.build(candidates), { minify: false }).code;
  built = { js, css };
  return built;
}

async function open(page: Page, width: number, dark: boolean) {
  const { js, css } = await build();
  await page.setViewportSize({ width: Math.max(width, 320), height: 1100 });
  await page.unrouteAll();
  await page.route('http://preview.test/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/') {
      return route.fulfill({ contentType: 'text/html', body: `<!doctype html><html lang="ko" class="${dark ? 'dark' : ''}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head><body class="bg-background text-foreground" style="margin:0"><div id="root"></div></body></html>` });
    }
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ data: [] }) });
  });
  await page.goto('about:blank');
  await page.goto('http://preview.test/');
  await page.addScriptTag({ content: js });
  await page.evaluate((w) => (window as unknown as { __mountDelivery: (w: number) => void }).__mountDelivery(w), width);
  await page.locator('[data-case="pending"]').waitFor();
  await page.waitForTimeout(200);
}

/** every box inside the column stays inside it */
const outside = (page: Page, rootSel: string) => page.evaluate((sel) => {
  const col = (document.querySelector(sel) as HTMLElement).getBoundingClientRect();
  const out: string[] = [];
  for (const el of document.querySelectorAll(`${sel} *`)) {
    const r = (el as HTMLElement).getBoundingClientRect();
    if (r.width <= 1 || r.height <= 1) continue; // a 1 × 1 off-screen part (sr-only) is not a visible part
    if (r.right > col.right + 0.5 || r.left < col.left - 0.5) out.push(`${el.tagName.toLowerCase()} ${Math.round(r.left - col.left)}..${Math.round(r.right - col.left)} of ${Math.round(col.width)}`);
  }
  return { out, scroll: [document.documentElement.scrollWidth, document.documentElement.clientWidth] };
}, rootSel);


for (const width of [390, 1440]) {
  for (const dark of [false, true]) {
    const tag = `${width}-${dark ? 'dark' : 'light'}`;
    test.describe(`delivery timing ${tag}`, () => {
      test.use(width === 390 ? { hasTouch: true, isMobile: true } : {});
      test(`[SID:5046] the delivery choice and the line under the bubble stay inside their column; a runtime note wraps, the buttons are touch-sized (${tag})`, async ({ page }) => {
        mkdirSync(SHOTS, { recursive: true });
        await open(page, width, dark);
        const m = await outside(page, '#col');
        expect(m.out, `running past the column: ${m.out.join(' | ')}`).toEqual([]);
        expect(m.scroll[0], 'no horizontal overflow').toBeLessThanOrEqual(m.scroll[1]);
        if (width === 390) {
          for (const name of ['지금 끼어들기', '끝나고 이어서']) {
            const box = await page.locator('[data-case="choice"]').getByRole('button', { name, exact: true }).boundingBox();
            expect(box!.height, `${name} on touch is at least 44 high`).toBeGreaterThanOrEqual(44);
          }
        }
        // a long note is wrapped (more than one line), never cut and never widening the column
        const note = await page.locator('[data-testid="delivery-choice-note"]').first().evaluate((e) => ({ h: e.getBoundingClientRect().height, lh: parseFloat(getComputedStyle(e).lineHeight) }));
        if (width === 390) expect(note.h, 'the long runtime note wraps on a phone (it is never cut)').toBeGreaterThan(note.lh * 1.5);
        else expect(note.h, 'on a wide column it is at most a couple of lines').toBeLessThanOrEqual(note.lh * 3 + 1);
        await page.screenshot({ path: path.join(SHOTS, `delivery-timing-${tag}.png`), fullPage: true });
      });
    });
  }
}
