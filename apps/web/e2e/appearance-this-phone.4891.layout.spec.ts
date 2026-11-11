/**
 * story 4891 (UI-8 · settings › 화면 + 이 폰 · piece ③) — the theme card, the language card and the «이 폰» check-number card, measured in Chromium on a touch phone (390 × 844): the REAL components (bundled with esbuild,
 * not copied) and the real Tailwind build. Rule: every press is ≥ 44 × 44, no visible text is under 12 px, nothing runs past the width, no old (non-ds) part is drawn; the choices and the handlers are the old ones.
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
  const bodies: Record<string, string> = {
    // a theme the page can flip: next-themes' hook is replaced by a tiny store so a choice is visible on the select
    'next-themes': "import { useSyncExternalStore } from 'react'; let t = 'system'; const subs = new Set(); export function useTheme() { const theme = useSyncExternalStore((cb) => { subs.add(cb); return () => subs.delete(cb); }, () => t, () => t); return { theme, systemTheme: 'light', setTheme(v) { t = v; window.__themeCalls = (window.__themeCalls || []).concat(v); subs.forEach((f) => f()); } }; }",
  };
  const filter = new RegExp(`^(${Object.keys(bodies).map((k) => k.replace(/[/.-]/g, '\\$&')).join('|')})$`);
  const out = await esbuild.build({
    stdin: {
      contents: `
        import React from 'react'; import { createRoot } from 'react-dom/client'; import { NextIntlClientProvider } from 'next-intl';
        import ko from './messages/ko.json';
        import { PhoneBridgeContext } from './src/components/providers/phone-bridge-context';
        import { ThemeSettings } from './src/components/settings/theme-settings';
        import { LanguageSettings } from './src/components/settings/language-settings';
        import { ThisPhoneCard } from './src/components/settings/this-phone-card';
        window.__mount = (mode) => {
          const phoneCall = async () => (mode === 'failed' ? { id: 'x', ok: false, code: 'timeout' } : { id: 'x', ok: true, key_number: '324 642' });
          createRoot(document.getElementById('root')).render(React.createElement(NextIntlClientProvider, { locale: 'ko', messages: ko, timeZone: 'Asia/Seoul' },
            React.createElement(PhoneBridgeContext.Provider, { value: { inPhoneApp: true, phoneCall } },
              React.createElement('div', { style: { padding: '16px', display: 'grid', gap: '12px' } },
                React.createElement(ThemeSettings), React.createElement(LanguageSettings), React.createElement(ThisPhoneCard)))));
        };`,
      resolveDir: WEB, loader: 'tsx',
    },
    bundle: true, format: 'iife', platform: 'browser', write: false, logLevel: 'silent', jsx: 'automatic',
    tsconfig: path.join(WEB, 'tsconfig.json'),
    define: { 'process.env.NODE_ENV': '"production"' },
    plugins: [
      { name: 'appearance-4891-stubs', setup(b) {
        b.onResolve({ filter }, (a) => ({ path: a.path, namespace: 'stub4891a' }));
        b.onLoad({ filter: /.*/, namespace: 'stub4891a' }, (a) => ({ contents: bodies[a.path]!, loader: 'js', resolveDir: WEB }));
      } },
      layoutStubPlugin(),
    ],
  });
  const js = out.outputFiles[0]!.text;
  const candidates = [...new Set([...js.matchAll(/"([^"\n]+)"/g)].flatMap((m) => m[1]!.split(/\s+/)).filter(Boolean))];
  const compiler = await compile(readFileSync(path.join(APP, 'globals.css'), 'utf8'), { base: APP, onDependency: () => {} });
  const css = (optimize as unknown as (c: string, o?: object) => { code: string })(compiler.build(candidates), { minify: false }).code;
  built = { js, css };
  return built;
}

async function open(page: Page, mode: 'number' | 'failed' = 'number') {
  const { js, css } = await build();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.unrouteAll();
  await page.route('http://preview.test/**', async (route) => {
    if (new URL(route.request().url()).pathname === '/') {
      return route.fulfill({ contentType: 'text/html', body: `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head><body class="bg-ds-canvas text-ds-ink"><div id="root"></div></body></html>` });
    }
    return route.fulfill({ status: 404, body: '{}' });
  });
  await page.addInitScript(() => { (window as unknown as { process: unknown }).process = { env: {} }; });
  await page.goto('about:blank');
  await page.goto('http://preview.test/');
  await page.addScriptTag({ content: js });
  await page.evaluate((m) => (window as unknown as { __mount: (m: string) => void }).__mount(m), mode);
  await page.locator('select').first().waitFor();
  await page.locator(mode === 'number' ? '[data-testid="this-phone-number"]' : '[data-testid="this-phone-retry"]').waitFor();
}

const measure = (page: Page) => page.evaluate(() => {
  const vis = (e: Element) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== 'hidden'; };
  const presses = [...document.querySelectorAll('button, [role=switch], a[href], input, select, summary')].filter(vis);
  const small = presses.filter((e) => { const r = e.getBoundingClientRect(); return r.width < 43.5 || r.height < 43.5; }).map((e) => `${(e.getAttribute('aria-label') || e.textContent || e.tagName).trim().slice(0, 14)} ${Math.round(e.getBoundingClientRect().width)}x${Math.round(e.getBoundingClientRect().height)}`);
  const leaves = [...document.querySelectorAll('body *')].filter((e) => e.children.length === 0 && (e.textContent || '').trim() && vis(e));
  const tiny = leaves.filter((e) => parseFloat(getComputedStyle(e).fontSize) < 12).map((e) => `${(e.textContent || '').trim().slice(0, 14)} ${getComputedStyle(e).fontSize}`);
  return { presses: presses.length, selects: document.querySelectorAll('select').length, small, tiny, overflowX: document.documentElement.scrollWidth > innerWidth + 1,
    oldSlots: [...document.querySelectorAll('[data-slot]')].map((e) => e.getAttribute('data-slot')!).filter((s) => !s.startsWith('ds-')), cards: document.querySelectorAll('[data-slot="ds-card"]').length };
});

test.describe('on a touch phone (390 × 844)', () => {
  test.use({ hasTouch: true, isMobile: true });

  for (const mode of ['number', 'failed'] as const) {
    test(`[SID:4891] ${mode}: every press (the two selects${mode === 'failed' ? ' · «다시 읽기»' : ''}) is at least 44 × 44, no text under 12 px, no old part, no overflow`, async ({ page }) => {
      await open(page, mode);
      const m = await measure(page);
      expect(m.selects, 'theme + language').toBe(2);
      expect(m.cards, 'theme · language · this phone').toBe(3);
      // reverted (the 36 px select · the 28 px «다시 읽기» · a 14 px text-sm line) → the lists are not empty
      expect(m.small, `presses under 44 px: ${m.small.join(' · ')}`).toEqual([]);
      expect(m.tiny, `text under 12 px: ${m.tiny.join(' · ')}`).toEqual([]);
      expect(m.overflowX).toBe(false);
      expect(m.oldSlots, 'old (non-ds) parts drawn').toEqual([]);
    });
  }

  test('[SID:4891] the theme select flips the theme (and the «following the system» line goes with «system»), the language select lists the two own-language names', async ({ page }) => {
    await open(page);
    const theme = page.locator('select').first();
    await expect(theme).toHaveValue('system');
    await expect(page.getByText('현재 시스템 설정')).toBeVisible();
    await theme.selectOption('dark');
    await expect(theme).toHaveValue('dark');
    expect(await page.evaluate(() => (window as unknown as { __themeCalls: string[] }).__themeCalls)).toEqual(['dark']);
    await expect(page.getByText('현재 시스템 설정')).toHaveCount(0);
    expect(await page.locator('select').nth(1).locator('option').allTextContents()).toEqual(['한국어', 'English']);
  });
});

test.describe('with a mouse (desktop size)', () => {
  test.use({ hasTouch: false, isMobile: false });

  test('[SID:4891] the selects keep the compact 36 px height (the 44 px floor is for a touch pointer only) and the chevron stays inside the select, centred', async ({ page }) => {
    await open(page);
    const boxes = await page.evaluate(() => [...document.querySelectorAll('select')].map((s) => {
      const sr = s.getBoundingClientRect();
      const icon = s.parentElement!.querySelector('svg, [data-slot="ds-icon"], span')!.getBoundingClientRect();
      return { h: Math.round(sr.height), iconInside: icon.right <= sr.right + 0.5 && icon.left >= sr.left, iconCentre: Math.abs((icon.top + icon.height / 2) - (sr.top + sr.height / 2)) <= 1.5 };
    }));
    expect(boxes.length).toBe(2);
    for (const b of boxes) { expect(b.h).toBe(36); expect(b.iconInside).toBe(true); expect(b.iconCentre).toBe(true); }
  });
});

test.describe('chevron on a touch phone', () => {
  test.use({ hasTouch: true, isMobile: true });
  test('[SID:4891] at the 44 px floor the chevron is still centred in the select', async ({ page }) => {
    await open(page);
    const off = await page.evaluate(() => [...document.querySelectorAll('select')].map((s) => {
      const sr = s.getBoundingClientRect();
      const icon = s.parentElement!.querySelector('svg, [data-slot="ds-icon"], span')!.getBoundingClientRect();
      return Math.abs((icon.top + icon.height / 2) - (sr.top + sr.height / 2));
    }));
    for (const o of off) expect(o).toBeLessThanOrEqual(1.5);
  });
});
