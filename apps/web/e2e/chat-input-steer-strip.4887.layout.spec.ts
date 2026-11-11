/**
 * story 4887 (UI-4 P5-b · AC3 «지시 대상 이름표 칩») — the steer chip strip, measured in Chromium with the REAL `ChatInput` (bundled with esbuild, not copied) and the real Tailwind build of globals.css; only the app shell around it is stubbed.
 * The rule: steer mode is ONE strip — the «방향 전환 지시» chip and the two controls on the same line (a title row above them was the old info-coloured box), wrapping under the chip on a narrow screen without squeezing the controls, with no box of its own;
 * and the two controls keep a visible boundary against the page (WCAG 1.4.11: ≥ 3:1) — they used to sit on a tinted panel and no longer do.
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

let built: { js: string; css: string } | null = null;
async function build() {
  if (built) return built;
  const esbuild = req('esbuild') as typeof import('esbuild');
  const out = await esbuild.build({
    stdin: {
      contents: `
        import React from 'react'; import { createRoot } from 'react-dom/client'; import { NextIntlClientProvider } from 'next-intl';
        import ko from './messages/ko.json';
        import { ChatInput } from './src/components/chat/chat-input';
        window.__mount = () => {
          createRoot(document.getElementById('root')).render(React.createElement(NextIntlClientProvider, { locale: 'ko', messages: ko, timeZone: 'Asia/Seoul' },
            React.createElement('div', { id: 'composer', style: { width: '100%', padding: '8px' } },
              React.createElement(ChatInput, { onSend: async () => {}, onUploadFile: async (f) => ({ url: 'u', name: f.name, content_type: f.type, size: f.size }), threadId: 't1', projectId: 'p1', currentTeamMemberId: 'me-1', participants: [{ member_id: 'me-1', name: '나' }, { member_id: 'a-1', name: '개발 에이전트' }] }))));
        };`,
      resolveDir: WEB, loader: 'tsx',
    },
    bundle: true, format: 'iife', platform: 'browser', write: false, logLevel: 'silent', jsx: 'automatic',
    tsconfig: path.join(WEB, 'tsconfig.json'),
    define: { 'process.env.NODE_ENV': '"production"', 'process.env.NEXT_PUBLIC_APP_URL': '"https://app.sprintable.ai"' },
    plugins: [layoutStubPlugin()],
  });
  const js = out.outputFiles[0]!.text;
  const candidates = [...new Set([...js.matchAll(/"([^"\n]+)"/g)].flatMap((m) => m[1]!.split(/\s+/)).filter(Boolean))];
  const compiler = await compile(readFileSync(path.join(APP, 'globals.css'), 'utf8'), { base: APP, onDependency: () => {} });
  const css = (optimize as unknown as (c: string, o?: object) => { code: string })(compiler.build(candidates), { minify: false }).code;
  built = { js, css };
  return built;
}

async function open(page: Page, width: number) {
  const { js, css } = await build();
  await page.setViewportSize({ width, height: 700 });
  await page.unrouteAll();
  await page.route('http://preview.test/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/') {
      return route.fulfill({ contentType: 'text/html', body: `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head><body style="margin:0"><div id="root"></div></body></html>` });
    }
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ data: [] }) });
  });
  await page.goto('about:blank');
  await page.goto('http://preview.test/');
  await page.addScriptTag({ content: js });
  await page.evaluate(() => (window as unknown as { __mount: () => void }).__mount());
  await page.getByTestId('chat-attach-upload').waitFor();
}



const KO = JSON.parse(readFileSync(path.join(WEB, 'messages/ko.json'), 'utf8')).chats as Record<string, string>;
const toggleSel = `button[aria-label="${KO.steerToggleLabel}"]`;
const mid = (b: { y: number; height: number }) => b.y + b.height / 2;

test('[SID:4887] on a desktop the chip, the target and the work item share ONE line, and the strip is a single short row (the old panel was a title row above the controls)', async ({ page }) => {
  await open(page, 1100);
  await page.click(toggleSel);
  const strip = page.getByTestId('steer-strip');
  await strip.waitFor();
  const s = (await strip.boundingBox())!;
  const chip = (await page.getByTestId('steer-chip').boundingBox())!;
  const select = (await page.locator('[data-testid="steer-strip"] select').boundingBox())!;
  const input = (await page.locator('[data-testid="steer-strip"] input').boundingBox())!;
  for (const [name, b] of [['the select', select], ['the work-item field', input]] as const) {
    expect(Math.abs(mid(b) - mid(chip)), `${name} is on the chip's line (a title row above would put it lower)`).toBeLessThanOrEqual(6); // reverted (the old panel: a title row, then the controls) → ≥ 20
  }
  expect(s.height, `the strip is one short row (${Math.round(s.height)} px)`).toBeLessThanOrEqual(40);
});

test('[SID:4887] the strip has no box of its own: transparent, no border (the old panel was an info-coloured bordered box)', async ({ page }) => {
  await open(page, 1100);
  await page.click(toggleSel);
  await page.getByTestId('steer-strip').waitFor();
  const st = await page.getByTestId('steer-strip').evaluate((e) => { const c = getComputedStyle(e); return { bg: c.backgroundColor, border: c.borderTopWidth, pad: c.paddingTop }; });
  expect(['rgba(0, 0, 0, 0)', 'transparent']).toContain(st.bg); // reverted → an info tint
  expect(st.border).toBe('0px');
  expect(st.pad).toBe('0px');
});

/** the boundary contrast of the two controls: any CSS colour (oklch / color-mix / rgba) is painted onto a 1×1 canvas to resolve it, then composited over the surface the boundary meets */
async function boundaryContrast(page: Page, scheme: 'light' | 'dark') {
  await page.emulateMedia({ colorScheme: scheme });
  // the controls carry `transition-colors`: a computed colour read right after the theme flips is the colour the transition STARTED from (the old theme's) — so the dark run measured the LIGHT border. Turn transitions off first: the computed styles are then final, with no timer.
  await page.addStyleTag({ content: '*, *::before, *::after { transition: none !important; }' });
  await page.evaluate((sc) => { document.documentElement.classList.toggle('dark', sc === 'dark'); }, scheme);
  return page.evaluate(() => {
    const px = (css: string) => { const c = document.createElement('canvas'); c.width = c.height = 1; const g = c.getContext('2d')!; g.clearRect(0, 0, 1, 1); g.fillStyle = css; g.fillRect(0, 0, 1, 1); const d = g.getImageData(0, 0, 1, 1).data; return [d[0]!, d[1]!, d[2]!, d[3]! / 255] as const; };
    const lum = (r: number, g: number, b: number) => { const f = (v: number) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
    const over = (top: readonly number[], bottom: readonly number[]) => [top[0]! * top[3]! + bottom[0]! * (1 - top[3]!), top[1]! * top[3]! + bottom[1]! * (1 - top[3]!), top[2]! * top[3]! + bottom[2]! * (1 - top[3]!)] as const;
    // the surface a control meets: the first ancestor with a painted background (else the page's, else white)
    const surface = (el: Element) => { let e: Element | null = el.parentElement; while (e) { const c = px(getComputedStyle(e).backgroundColor); if (c[3] > 0.99) return c; e = e.parentElement; } const b = px(getComputedStyle(document.body).backgroundColor); return b[3] > 0.99 ? b : ([255, 255, 255, 1] as const); };
    const ratio = (a: number, b: number) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    const out: Record<string, number> = {};
    for (const [name, el] of [['select', document.querySelector('[data-testid="steer-strip"] select')!], ['input', document.querySelector('[data-testid="steer-strip"] input')!]] as const) {
      const cs = getComputedStyle(el); const bg = surface(el);
      const border = over(px(cs.borderTopColor), bg);
      out[`${name} border vs the page`] = Math.round(ratio(lum(...border), lum(...bg)) * 100) / 100;
      // the painted FACE is the ds sunk surface in this theme (not the base Input's translucent `dark:bg-input/30`): compare with a probe element that carries the token's own class
      const probe = document.createElement('div'); probe.className = 'bg-ds-surface-sunk'; document.body.appendChild(probe);
      const token = getComputedStyle(probe).backgroundColor; probe.remove();
      out[`${name} face is the ds token`] = (cs.backgroundColor === token ? 1 : 0);
      // what was measured (so a failure says which colours met): the boundary colour over the surface, and the surface itself
      out[`${name} border rgb`] = border.map(Math.round).join(',') as unknown as number;
      out[`${name} surface rgb`] = bg.slice(0, 3).map(Math.round).join(',') as unknown as number;
    }
    return out;
  });
}

for (const scheme of ['light', 'dark'] as const) {
  test(`[SID:4887] ${scheme}: the target select and the work-item field keep a visible boundary against the page (WCAG 1.4.11, >= 3:1) now that no tinted panel sits behind them`, async ({ page }) => {
    await open(page, 1100);
    await page.click(toggleSel);
    await page.getByTestId('steer-strip').waitFor();
    const r = await boundaryContrast(page, scheme);
    for (const name of ['select', 'input']) {
      expect(r[`${name} border vs the page`]!, `${scheme} ${name}: ${JSON.stringify(r)}`).toBeGreaterThanOrEqual(3); // reverted (a plain border-input, about 1.2) → fails
      expect(r[`${name} face is the ds token`]!, `${scheme} ${name}: the painted face is the ds sunk surface (${JSON.stringify(r)})`).toBe(1); // reverted (no dark: face) → the legacy translucent fill in dark
    }
  });
}

test.describe('on a narrow touch screen', () => {
  test.use({ hasTouch: true, isMobile: true });
  test('[SID:4887] at 320 px the strip WRAPS (the chip, then the controls) without running past the screen, and the text box under it keeps a usable width', async ({ page }) => {
    await open(page, 320);
    await page.tap(toggleSel);
    await page.getByTestId('steer-strip').waitFor();
    const w = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
    expect(w.scroll, 'no horizontal overflow at 320 px').toBeLessThanOrEqual(w.client);
    const select = (await page.locator('[data-testid="steer-strip"] select').boundingBox())!;
    const input = (await page.locator('[data-testid="steer-strip"] input').boundingBox())!;
    // the controls have a 7rem floor, so they WRAP under the chip instead of being squeezed on its line (a zero basis kept all three on one line: the work-item field was 78 px)
    expect(select.width, `the target select is usable (${Math.round(select.width)} px)`).toBeGreaterThanOrEqual(100);
    expect(input.width, `the work-item field is usable (${Math.round(input.width)} px)`).toBeGreaterThanOrEqual(100); // reverted (min-w-0 · basis 0) → ~78
    const chip = (await page.getByTestId('steer-chip').boundingBox())!;
    expect(Math.max(select.y, input.y) - chip.y, 'at least one control wrapped to a line below the chip').toBeGreaterThan(chip.height / 2);
    const box = (await page.locator('textarea[data-slot="textarea"]').boundingBox())!;
    expect(box.width, `the text box keeps a usable width (${Math.round(box.width)} px)`).toBeGreaterThanOrEqual(96);
  });
});
