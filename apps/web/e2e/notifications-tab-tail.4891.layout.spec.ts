/**
 * story 4891 (UI-8 · the notifications tab's tail · PO 11-10) — the three cards under the notifications card (the standup deadline · the gate level table · the auto-refresh chips) and the legal footer, measured in Chromium on a touch phone
 * (390 × 844): the REAL components (bundled with esbuild, not copied) and the real Tailwind build. Measured on dev before (same tab): 22 presses under 44 px — the time field 42 · «Save» 28 · the gate level buttons 28 ×12 · the refresh chips 34 ×5 ·
 * the legal links 20 ×3. The rule: every press is ≥ 44 × 44 and no visible text is under 12 px; the values and the handlers are the old ones.
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
    '@/lib/db/client': "export const fetchWithAuth = (u, i) => fetch(u, i);",
    'next/navigation': "export function useRouter() { return { push() {}, replace() {}, back() {}, refresh() {}, prefetch() {} }; } export function useSearchParams() { return new URLSearchParams(''); } export function usePathname() { return '/settings'; }",
  };
  const filter = new RegExp(`^(${Object.keys(bodies).map((k) => k.replace(/[/.-]/g, '\\$&')).join('|')})$`);
  const out = await esbuild.build({
    stdin: {
      contents: `
        import React from 'react'; import { createRoot } from 'react-dom/client'; import { NextIntlClientProvider } from 'next-intl';
        import ko from './messages/ko.json';
        import { RefreshProvider } from './src/contexts/refresh-context';
        import { RefreshSettings } from './src/components/settings/refresh-settings';
        import { StandupDeadlineSection } from './src/components/settings/standup-deadline-section';
        import { GateLevelMatrix } from './src/components/settings/gate-level-matrix';
        import { LegalFooter } from './src/components/legal/legal-footer';
        window.__mount = () => {
          createRoot(document.getElementById('root')).render(React.createElement(NextIntlClientProvider, { locale: 'ko', messages: ko, timeZone: 'Asia/Seoul' }, React.createElement(RefreshProvider, null,
            React.createElement('div', { style: { padding: '16px' } },
              React.createElement(StandupDeadlineSection, { projectId: 'p1' }),
              React.createElement(GateLevelMatrix, { surface: 'project', projectId: 'p1', canEdit: true }),
              React.createElement(RefreshSettings),
              React.createElement(LegalFooter)))));
        };`,
      resolveDir: WEB, loader: 'tsx',
    },
    bundle: true, format: 'iife', platform: 'browser', write: false, logLevel: 'silent', jsx: 'automatic',
    tsconfig: path.join(WEB, 'tsconfig.json'),
    define: { 'process.env.NODE_ENV': '"production"', 'process.env.NEXT_PUBLIC_APP_URL': '"https://app.sprintable.ai"', 'process.env.NEXT_PUBLIC_OAUTH_ENABLED': '"true"' },
    plugins: [
      { name: 'tail-4891-stubs', setup(b) {
        b.onResolve({ filter }, (a) => ({ path: a.path, namespace: 'stub4891t' }));
        b.onLoad({ filter: /.*/, namespace: 'stub4891t' }, (a) => ({ contents: bodies[a.path]!, loader: 'js', resolveDir: WEB }));
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

async function open(page: Page, width: number, height: number) {
  const { js, css } = await build();
  await page.setViewportSize({ width, height });
  await page.unrouteAll();
  await page.route('http://preview.test/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/') {
      return route.fulfill({ contentType: 'text/html', body: `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head><body class="bg-background text-foreground"><div id="root"></div></body></html>` });
    }
    // the gate table's cells (one of them overridden → its tag and the ↺ revert press are drawn too)
    if (url.pathname === '/api/projects/p1/gate-config') {
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ data: [
        { work_type: 'done', actor_type: 'agent', level: 'ask', source: 'org_default' }, { work_type: 'done', actor_type: 'human', level: 'auto', source: 'override' },
        { work_type: 'merge', actor_type: 'agent', level: 'block', source: 'org_default' }, { work_type: 'merge', actor_type: 'human', level: 'ask', source: 'override' },
      ] }) });
    }
    return route.fulfill({ status: 404, body: '{}' });
  });
  await page.addInitScript(() => { (window as unknown as { process: unknown }).process = { env: {} }; });
  await page.goto('about:blank');
  await page.goto('http://preview.test/');
  await page.addScriptTag({ content: js });
  await page.evaluate(() => (window as unknown as { __mount: () => void }).__mount());
  await page.getByTestId('refresh-settings').waitFor();
  await page.locator('[role=group] button').first().waitFor();
}


const measure = (page: Page) => page.evaluate(() => {
  const vis = (e: Element) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== 'hidden'; };
  const presses = [...document.querySelectorAll('button, [role=switch], a[href], input, select, summary')].filter(vis);
  const small = presses.filter((e) => { const r = e.getBoundingClientRect(); return r.width < 43.5 || r.height < 43.5; }).map((e) => `${(e.getAttribute('aria-label') || e.textContent || e.tagName).trim().slice(0, 14)} ${Math.round(e.getBoundingClientRect().width)}x${Math.round(e.getBoundingClientRect().height)}`);
  const leaves = [...document.querySelectorAll('body *')].filter((e) => e.children.length === 0 && (e.textContent || '').trim() && vis(e));
  const tiny = leaves.filter((e) => parseFloat(getComputedStyle(e).fontSize) < 12).map((e) => `${(e.textContent || '').trim().slice(0, 14)} ${getComputedStyle(e).fontSize}`);
  // a gate row whose controls run past its own right edge (clipped) — the trailing part must wrap UNDER the name when the width is short
  const clipped = [...document.querySelectorAll('[data-slot="ds-list-row"]')].filter((row) => { const rr = row.getBoundingClientRect(); return [...row.querySelectorAll('*')].some((c) => c.getBoundingClientRect().right > rr.right + 1); }).length;
  return { presses: presses.length, small, tiny, clipped, reverts: document.querySelectorAll('button[aria-label]').length, overflowX: document.documentElement.scrollWidth > innerWidth + 1,
    chips: document.querySelectorAll('[data-testid="refresh-settings"] button').length, levelButtons: document.querySelectorAll('[role=group] button').length };
});

test.describe('on a touch phone (390 × 844)', () => {
  test.use({ hasTouch: true, isMobile: true });

  test('[SID:4891] every press in the three tail cards and the legal links is at least 44 × 44, and no text is under 12 px', async ({ page }) => {
    await open(page, 390, 844);
    const m = await measure(page);
    expect(m.chips, 'the five interval chips').toBe(5);
    expect(m.levelButtons, 'the gate level buttons (2 work types × 2 actors × 3 levels)').toBe(12);
    // reverted (the raw 34 px chips · the «sm» level buttons · the 20 px links) → the small list is not empty
    expect(m.small, `presses under 44 px: ${m.small.join(' · ')}`).toEqual([]);
    expect(m.tiny, `text under 12 px: ${m.tiny.join(' · ')}`).toEqual([]);
    expect(m.overflowX).toBe(false);
    expect(m.clipped, 'gate rows whose controls run past the row (override tag + ↺ + three level buttons must wrap, not clip)').toBe(0);
  });

  test('[SID:4891] the chips still pick one (aria-pressed follows the press) and the level buttons keep their pressed state', async ({ page }) => {
    await open(page, 390, 844);
    const chips = page.getByTestId('refresh-settings').getByRole('button');
    await chips.nth(1).tap();
    await expect(chips.nth(1)).toHaveAttribute('aria-pressed', 'true');
    await expect(chips.nth(0)).toHaveAttribute('aria-pressed', 'false');
  });
});
