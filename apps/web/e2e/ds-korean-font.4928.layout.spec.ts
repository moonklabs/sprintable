/**
 * story 4928 — Korean text in ds Chip · StatusLabel · ListRow subtitle is drawn in the BODY font, not the fixed-width font.
 * Why: the fixed-width space is 0.6 em (6.6 px at 11 px) — between Korean words that is 2.4× a body-font space (dev b85b2dbee: 720 places, +3.9 px a gap).
 * Measured in Chromium with the REAL ds parts (bundled with esbuild, not copied) and the real Tailwind build of globals.css:
 *  - a Korean chip / status label / second line: the computed font family is NOT the fixed-width family and the space between two Korean words is < 4.5 px;
 *  - the data pieces the callers mark (`Chip mono`, `DataText`) ARE the fixed-width family and keep their 6 px+ space;
 *  - nothing overflows sideways on a phone, light and dark.
 * The two families are pinned in the page (`--font-sans` / `--font-mono`) so the test does not depend on which fonts the machine has.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { expect, test, type Page } from '@playwright/test';
import { compile, optimize } from '@tailwindcss/node';

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
        import { Chip } from './src/components/ds/chip';
        import { StatusLabel } from './src/components/ds/status-label';
        import { ListRow } from './src/components/ds/list-row';
        import { DataText, joinDot } from './src/components/ds/data-text';
        const h = React.createElement;
        window.__mount = () => {
          createRoot(document.getElementById('root')).render(h(NextIntlClientProvider, { locale: 'ko', messages: ko, timeZone: 'Asia/Seoul' },
            h('div', { style: { padding: 16, display: 'flex', flexDirection: 'column', gap: 12 } },
              h('div', { 'data-case': 'chips', style: { display: 'flex', gap: 8, flexWrap: 'wrap' } },
                h(Chip, { tone: 'needs-hand', dot: true }, '서명 대기'),
                h(Chip, { tone: 'failed' }, '재시도 불가 상태'),
                h(Chip, { tone: 'done', dot: true }, '연결 안 됨'),
                h(Chip, { mono: true, tone: 'info' }, 'claude-haiku-5-5')),
              h('div', { 'data-case': 'status' }, h(StatusLabel, { status: 'offline', label: '연결 끊김 · 상태 모름' })),
              h('div', { 'data-case': 'row', style: { width: '100%' } },
                h(ListRow, { title: '결제 수단 추가 승인', subtitle: joinDot(['구성원 · 프로젝트 팀 1곳', h(DataText, { key: 'host' }, 'SYJ-MacBook-Pro'), '6시간 전']), trailing: h(Chip, { tone: 'needs-hand' }, '승인 대기') })),
              h('span', { id: 'probe-mono', className: 'font-mono text-ds-mono-md' }, '프로젝트 팀'),
              h('span', { id: 'probe-sans', className: 'font-sans text-ds-mono-md' }, '프로젝트 팀'))));
        };`,
      resolveDir: WEB, loader: 'tsx',
    },
    bundle: true, format: 'iife', platform: 'browser', write: false, logLevel: 'silent', jsx: 'automatic',
    tsconfig: path.join(WEB, 'tsconfig.json'),
    define: { 'process.env.NODE_ENV': '"production"' },
  });
  const js = out.outputFiles[0]!.text;
  const candidates = [...new Set(js.match(/[^\s"'`${}<>;,]+/g) ?? [])];
  const compiler = await compile(readFileSync(path.join(APP, 'globals.css'), 'utf8'), { base: APP, onDependency: () => {} });
  const css = (optimize as unknown as (c: string, o?: object) => { code: string })(compiler.build(candidates), { minify: false }).code;
  built = { js, css };
  return built;
}

async function open(page: Page, width: number, dark: boolean) {
  const { js, css } = await build();
  await page.setViewportSize({ width, height: 800 });
  await page.emulateMedia({ colorScheme: dark ? 'dark' : 'light' });
  await page.setContent(`<!doctype html><html lang="ko"${dark ? ' class="dark"' : ''}><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
    <style>${css}</style><style>:root{--font-sans:Arial,Helvetica,sans-serif;--font-mono:"DejaVu Sans Mono","Courier New",monospace;} body{font-family:var(--font-sans);margin:0}</style></head><body><div id="root"></div></body></html>`);
  await page.addScriptTag({ content: js });
  await page.evaluate(() => (window as unknown as { __mount: () => void }).__mount());
  await page.waitForSelector('[data-slot="ds-chip"]');
}

/** the width of the first space between two Korean words inside `el` (own text nodes), and its computed font family */
const MEASURE = `(sel) => {
  const el = document.querySelector(sel); if (!el) return null;
  const fam = getComputedStyle(el).fontFamily;
  const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT); let n; let space = null;
  while ((n = w.nextNode())) {
    const t = n.nodeValue; const i = t.search(/[\\uAC00-\\uD7A3] [\\uAC00-\\uD7A3]/);
    if (i >= 0) { const r = document.createRange(); r.setStart(n, i + 1); r.setEnd(n, i + 2); space = r.getBoundingClientRect().width; break; }
  }
  return { fam, space, overflow: document.documentElement.scrollWidth > innerWidth + 1 };
}`;
type M = { fam: string; space: number | null; overflow: boolean } | null;
const measure = (page: Page, sel: string) => page.evaluate(`(${MEASURE})(${JSON.stringify(sel)})`) as Promise<M>;

for (const [name, width, dark] of [['1440 light', 1440, false], ['1440 dark', 1440, true], ['390 phone light', 390, false], ['390 phone dark', 390, true]] as const) {
  test.describe(`4928 Korean text is body font · ${name}`, () => {
    test('chip · status label · row second line: not the fixed-width family, spaces stay narrow', async ({ page }) => {
      await open(page, width, dark);
      const mono = (await measure(page, '#probe-mono'))!;
      const sans = (await measure(page, '#probe-sans'))!;
      expect(mono.space, 'the fixed-width probe space (6 px+)').toBeGreaterThan(5.5);
      expect(sans.space!, 'the body probe space').toBeLessThan(4.5);
      expect(mono.fam).not.toBe(sans.fam);
      for (const sel of ['[data-case="chips"] [data-slot="ds-chip"]:nth-child(2)', '[data-case="chips"] [data-slot="ds-chip"]:nth-child(3)', '[data-slot="ds-status-label"]', '[data-slot="ds-list-row-subtitle"]']) {
        const m = (await measure(page, sel))!;
        expect(m, sel).not.toBeNull();
        expect(m.fam, `${sel} family`).not.toBe(mono.fam);
        expect(m.space, `${sel} space between Korean words`).not.toBeNull();
        expect(m.space!, `${sel} space between Korean words`).toBeLessThan(4.5);
      }
    });

    test('the data pieces callers mark stay fixed-width: Chip mono · DataText', async ({ page }) => {
      await open(page, width, dark);
      const mono = (await measure(page, '#probe-mono'))!;
      const chipMono = (await measure(page, '[data-case="chips"] [data-slot="ds-chip"]:nth-child(4)'))!;
      const data = (await measure(page, '[data-slot="ds-data-text"]'))!;
      expect(chipMono.fam).toBe(mono.fam);
      expect(data.fam).toBe(mono.fam);
    });

    test('nothing overflows sideways', async ({ page }) => {
      await open(page, width, dark);
      expect((await measure(page, '[data-case="row"]'))!.overflow).toBe(false);
    });
  });
}
