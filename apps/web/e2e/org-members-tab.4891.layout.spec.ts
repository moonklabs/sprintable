/**
 * story 4891 (UI-8 · settings › 조직 구성원 · piece ⑤b) — the members section (invite form · project picker · member rows with role select / remove · pending-invite rows) and the remove dialog, measured in Chromium on a touch phone (390 × 844):
 * the REAL components (bundled with esbuild, not copied) and the real Tailwind build. Rule: every press is ≥ 44 × 44 (the aria-hidden placeholder button of a row without actions is not a press), no visible text is under 12 px, nothing runs past the width,
 * no old (non-ds) part is drawn.
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
        import { OrgMembersSection } from './src/components/settings/org-members-section';
        window.__mount = () => {
          createRoot(document.getElementById('root')).render(React.createElement(NextIntlClientProvider, { locale: 'ko', messages: ko, timeZone: 'Asia/Seoul' },
            React.createElement('div', { style: { padding: '16px' } }, React.createElement(OrgMembersSection, { orgId: 'org-1', currentRole: 'admin' }))));
        };`,
      resolveDir: WEB, loader: 'tsx',
    },
    bundle: true, format: 'iife', platform: 'browser', write: false, logLevel: 'silent', jsx: 'automatic',
    tsconfig: path.join(WEB, 'tsconfig.json'),
    define: { 'process.env.NODE_ENV': '"production"' },
    plugins: [layoutStubPlugin()],
  });
  const js = out.outputFiles[0]!.text;
  const candidates = tailwindCandidates(js);
  const compiler = await compile(readFileSync(path.join(APP, 'globals.css'), 'utf8'), { base: APP, onDependency: () => {} });
  const css = (optimize as unknown as (c: string, o?: object) => { code: string })(compiler.build(candidates), { minify: false }).code;
  built = { js, css };
  return built;
}

let patched: { role?: string } | null = null;
async function open(page: Page) {
  const { js, css } = await build();
  patched = null;
  await page.setViewportSize({ width: 390, height: 844 });
  await page.unrouteAll();
  await page.route('http://preview.test/**', async (route) => {
    const url = new URL(route.request().url());
    const json = (data: unknown) => route.fulfill({ contentType: 'application/json', body: JSON.stringify(data) });
    if (url.pathname === '/') {
      return route.fulfill({ contentType: 'text/html', body: `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head><body class="bg-ds-canvas text-ds-ink"><div id="root"></div></body></html>` });
    }
    if (url.pathname === '/api/me') return json({ data: { user_id: 'u-self' } });
    if (url.pathname === '/api/org-members' && route.request().method() === 'GET') {
      return json({ data: [
        { id: 'row-owner', user_id: 'u-owner', name: '오너', email: 'owner@example.com', role: 'owner', created_at: '2026-10-01T00:00:00Z' },
        { id: 'row-self', user_id: 'u-self', name: '나', email: 'me@example.com', role: 'admin', created_at: '2026-10-02T00:00:00Z' },
        { id: 'row-other', user_id: 'u-other', name: '아주 긴 이름을 가진 다른 팀원 아주 긴 이름', email: 'a-very-long-address-for-a-teammate@example.com', role: 'member', created_at: '2026-10-03T00:00:00Z' },
      ] });
    }
    if (url.pathname === '/api/org-members/row-other' && route.request().method() === 'PATCH') { patched = JSON.parse(route.request().postData() ?? '{}'); return json({ data: {} }); }
    if (url.pathname === '/api/organizations/org-1/invites') return json({ data: [{ id: 'inv-1', email: 'pending-with-a-long-address@example.com', role: 'member', status: 'pending', expires_at: '2099-01-01T00:00:00Z', invite_url: 'https://app.test/invite/abc' }] });
    if (url.pathname === '/api/projects') return json({ data: [{ id: 'p1', name: '알파' }, { id: 'p2', name: '베타 프로젝트의 아주 긴 이름' }] });
    if (url.pathname === '/api/org-members/row-other/affected-projects') return json({ data: [{ project_id: 'p1', project_name: '알파', role: 'member' }] });
    return route.fulfill({ status: 404, body: '{}' });
  });
  await page.addInitScript(() => { (window as unknown as { process: unknown }).process = { env: {} }; });
  await page.goto('about:blank');
  await page.goto('http://preview.test/');
  await page.addScriptTag({ content: js });
  await page.evaluate(() => (window as unknown as { __mount: () => void }).__mount());
  await page.locator('.divide-y select').first().waitFor();
}

const measure = (page: Page) => page.evaluate(() => {
  const vis = (e: Element) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== 'hidden' && !e.closest('[aria-hidden="true"]'); };
  const presses = [...document.querySelectorAll('button, [role=switch], a[href], input, select, summary')].filter(vis);
  const small = presses.filter((e) => { const r = e.getBoundingClientRect(); return r.width < 43.5 || r.height < 43.5; }).map((e) => `${(e.getAttribute('aria-label') || e.textContent || e.tagName).trim().slice(0, 14)} ${Math.round(e.getBoundingClientRect().width)}x${Math.round(e.getBoundingClientRect().height)}`);
  // named exemption: the ds CountBadge is 11 px mono by the UI-3 spec (a number beside the title, not reading text)
  const leaves = [...document.querySelectorAll('body *')].filter((e) => e.children.length === 0 && (e.textContent || '').trim() && vis(e) && !e.closest('[data-slot="ds-count-badge"]'));
  const tiny = leaves.filter((e) => parseFloat(getComputedStyle(e).fontSize) < 12).map((e) => `${(e.textContent || '').trim().slice(0, 14)} ${getComputedStyle(e).fontSize}`);
  // a row whose actions run past its own right edge
  const clipped = [...document.querySelectorAll('.divide-y > div')].filter((row) => { const rr = row.getBoundingClientRect(); return [...row.querySelectorAll('button, select')].some((c) => !c.closest('[aria-hidden="true"]') && c.getBoundingClientRect().right > rr.right + 0.5); }).length;
  return { presses: presses.length, small, tiny, clipped, overflowX: document.documentElement.scrollWidth > innerWidth + 1,
    // named exemption: the ds Dialog draws its overlay with the shared overlay part (slot `dialog-overlay`) — the ds part's own inside
    oldSlots: [...document.querySelectorAll('[data-slot]')].map((e) => e.getAttribute('data-slot')!).filter((s) => !s.startsWith('ds-') && s !== 'dialog-overlay'),
    oldClasses: [...document.querySelectorAll('[class]')].filter((e) => /(^|\s)(text-xs|text-sm|text-muted-foreground|text-foreground|text-destructive)(\s|$)/.test(e.getAttribute('class') || '')).map((e) => (e.getAttribute('class') || '').slice(0, 60)) };
});
async function expectClean(page: Page, label: string) {
  const m = await measure(page);
  expect(m.small, `${label}: presses under 44 px: ${m.small.join(' · ')}`).toEqual([]);
  expect(m.tiny, `${label}: text under 12 px: ${m.tiny.join(' · ')}`).toEqual([]);
  expect(m.clipped, `${label}: a row's actions run past the row`).toBe(0);
  expect(m.overflowX, `${label}: overflow`).toBe(false);
  expect(m.oldSlots, `${label}: old (non-ds) parts drawn`).toEqual([]);
  expect(m.oldClasses, `${label}: old text classes drawn`).toEqual([]);
  return m;
}

test.describe('on a touch phone (390 × 844)', () => {
  test.use({ hasTouch: true, isMobile: true });

  test('[SID:4891] the invite form, the member rows (long name · role select · [제거]) and the pending-invite row stand clean', async ({ page }) => {
    await open(page);
    await expectClean(page, 'list');
  });

  test('[SID:4891] the project picker open: the trigger and every project press are ≥44', async ({ page }) => {
    await open(page);
    await page.locator('[aria-expanded]').tap();
    await page.getByRole('button', { name: '알파' }).waitFor();
    await expectClean(page, 'picker open');
    await page.getByRole('button', { name: '알파' }).tap();
    await expect(page.getByRole('button', { name: '알파' })).toHaveAttribute('aria-pressed', 'true');
  });

  test('[SID:4891] a failed copy shows the raw invite address in a read-only field that is ≥44 (the clipboard refuses, as it can for a person)', async ({ page }) => {
    // a copy that fails the way it does for a person: the async clipboard refuses and the old execCommand route says no
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'clipboard', { value: { writeText: () => Promise.reject(new Error('denied')) }, configurable: true });
      document.execCommand = () => false;
    });
    await open(page);
    await page.getByRole('button', { name: /링크 복사/ }).tap();
    const raw = page.getByTestId('org-members-copy-failed-raw-invite-url');
    await raw.waitFor();
    await expect(raw).toHaveAttribute('readonly', '');
    await expectClean(page, 'copy failed');
  });

  test('[SID:4891] the role select reaches its request, and the remove dialog (ds Dialog) stands clean with the focus on «취소»', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' }); // the dialog's zoom-in would be measured mid-way (95 % of 44 px = 42)
    await open(page);
    await page.locator('.divide-y select').first().selectOption('admin');
    await expect.poll(() => patched).toEqual({ role: 'admin' });
    await page.locator('.divide-y button:not([aria-hidden])', { hasText: '제거' }).first().tap();
    const dlg = page.locator('[data-slot="ds-dialog-content"]');
    await dlg.waitFor();
    await expect(dlg.getByRole('button', { name: '취소' })).toBeFocused();
    await expectClean(page, 'remove dialog');
  });
});
