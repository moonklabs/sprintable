/**
 * story 4891 (UI-8 · settings › 조직 · piece ⑤a) — the organization card (owner's rename field · a member's read-only rows), the danger card and the org gate-policy card (posture buttons · two approver selects · save), measured in Chromium
 * on a touch phone (390 × 844): the REAL components (bundled with esbuild, not copied) and the real Tailwind build. Rule: every press is ≥ 44 × 44, no visible text is under 12 px, nothing runs past the width, no old (non-ds) part is drawn.
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
        import { OrganizationSection, OrgDangerSection } from './src/components/settings/organization-section';
        import { OrgGatePolicySection } from './src/components/settings/org-gate-policy-section';
        window.__mount = (scene) => {
          const info = { id: 'o1', name: '문클랩스', slug: 'moonklabs', plan: 'pro' };
          const calls = (window.__calls = []);
          createRoot(document.getElementById('root')).render(React.createElement(NextIntlClientProvider, { locale: 'ko', messages: ko, timeZone: 'Asia/Seoul' },
            React.createElement('div', { style: { padding: '16px', display: 'grid', gap: '12px' } },
              React.createElement(OrganizationSection, { orgInfo: scene === 'loading' ? null : info, role: scene === 'member' ? 'member' : 'owner', name: window.__name || '문클랩스', onNameChange: (v) => calls.push('name:' + v), onSave: () => calls.push('save'), saving: false, nameError: scene === 'error' ? '이미 있는 이름이에요' : null }),
              scene === 'loading' ? null : React.createElement(OrgGatePolicySection, { canEdit: scene !== 'member' }),
              scene === 'owner' ? React.createElement(OrgDangerSection, { onOpenDelete: () => calls.push('delete') }) : null)));
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

type Scene = 'owner' | 'member' | 'loading' | 'error';
async function open(page: Page, scene: Scene) {
  const { js, css } = await build();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.unrouteAll();
  await page.route('http://preview.test/**', async (route) => {
    const url = new URL(route.request().url());
    const json = (data: unknown) => route.fulfill({ contentType: 'application/json', body: JSON.stringify(data) });
    if (url.pathname === '/') {
      return route.fulfill({ contentType: 'text/html', body: `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head><body class="bg-ds-canvas text-ds-ink"><div id="root"></div></body></html>` });
    }
    if (url.pathname === '/api/gate-config/policy') return json({ data: { id: 'p1', org_id: 'o1', posture: 'balanced', merge_gate_default_approver_member_id: 'member-2', recipe_gate_default_approver_member_id: null, created_at: '2026-09-02T00:00:00Z', updated_at: '2026-09-02T00:00:00Z' } });
    if (url.pathname === '/api/org-members/eligible-approvers') return json({ data: [{ id: 'member-1', user_id: 'u1', name: '송윤재', email: 'iamyoonjae@moonklabs.com', role: 'owner' }, { id: 'member-2', user_id: 'u2', name: '페드루', email: 'pedro@moonklabs.com', role: 'admin' }] });
    return route.fulfill({ status: 404, body: '{}' });
  });
  await page.addInitScript(() => { (window as unknown as { process: unknown }).process = { env: {} }; });
  await page.goto('about:blank');
  await page.goto('http://preview.test/');
  await page.addScriptTag({ content: js });
  await page.evaluate((s) => (window as unknown as { __mount: (s: string) => void }).__mount(s), scene);
  if (scene === 'loading') await page.locator('[data-slot="ds-skeleton-group"]').first().waitFor();
  else if (scene === 'member') await page.getByText('moonklabs', { exact: true }).waitFor();
  else await page.locator('select').first().waitFor();
}

const measure = (page: Page) => page.evaluate(() => {
  const vis = (e: Element) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== 'hidden'; };
  const presses = [...document.querySelectorAll('button, [role=switch], a[href], input, select, summary')].filter(vis);
  const small = presses.filter((e) => { const r = e.getBoundingClientRect(); return r.width < 43.5 || r.height < 43.5; }).map((e) => `${(e.getAttribute('aria-label') || e.textContent || e.tagName).trim().slice(0, 14)} ${Math.round(e.getBoundingClientRect().width)}x${Math.round(e.getBoundingClientRect().height)}`);
  const leaves = [...document.querySelectorAll('body *')].filter((e) => e.children.length === 0 && (e.textContent || '').trim() && vis(e));
  const tiny = leaves.filter((e) => parseFloat(getComputedStyle(e).fontSize) < 12).map((e) => `${(e.textContent || '').trim().slice(0, 14)} ${getComputedStyle(e).fontSize}`);
  return { presses: presses.length, small, tiny, overflowX: document.documentElement.scrollWidth > innerWidth + 1,
    oldSlots: [...document.querySelectorAll('[data-slot]')].map((e) => e.getAttribute('data-slot')!).filter((s) => !s.startsWith('ds-')),
    oldClasses: [...document.querySelectorAll('[class]')].filter((e) => /(^|\s)(text-xs|text-sm|text-muted-foreground|text-foreground|text-destructive)(\s|$)/.test(e.getAttribute('class') || '')).map((e) => (e.getAttribute('class') || '').slice(0, 60)) };
});
async function expectClean(page: Page, label: string) {
  const m = await measure(page);
  expect(m.small, `${label}: presses under 44 px: ${m.small.join(' · ')}`).toEqual([]);
  expect(m.tiny, `${label}: text under 12 px: ${m.tiny.join(' · ')}`).toEqual([]);
  expect(m.overflowX, `${label}: overflow`).toBe(false);
  expect(m.oldSlots, `${label}: old (non-ds) parts drawn`).toEqual([]);
  expect(m.oldClasses, `${label}: old text classes drawn`).toEqual([]);
  return m;
}

test.describe('on a touch phone (390 × 844)', () => {
  test.use({ hasTouch: true, isMobile: true });

  test('[SID:4891] the owner: rename field + [저장], the policy card (3 posture buttons · 2 approver selects · [저장]) and the danger button stand clean', async ({ page }) => {
    await open(page, 'owner');
    const m = await expectClean(page, 'owner');
    // 1 rename input + 1 save + 3 posture + 2 selects + 1 policy save + 1 danger = 9
    expect(m.presses).toBe(9);
  });

  test('[SID:4891] a member: read-only rows (no field, no button besides none) and the read-only policy', async ({ page }) => {
    await open(page, 'member');
    const m = await expectClean(page, 'member');
    expect(m.presses).toBe(0);
  });

  test('[SID:4891] loading (named group) and the field error line', async ({ page }) => {
    await open(page, 'loading');
    await expectClean(page, 'loading');
    await open(page, 'error');
    await expectClean(page, 'error');
    await expect(page.locator('[role="alert"]').first()).toContainText('이미 있는 이름이에요');
  });

  test('[SID:4891] the presses still reach their handlers: the danger button hands the press to the page, a posture press flips aria-pressed', async ({ page }) => {
    await open(page, 'owner');
    await page.getByRole('button', { name: '조직 삭제' }).tap();
    expect(await page.evaluate(() => (window as unknown as { __calls: string[] }).__calls)).toContain('delete');
    const strict = page.locator('[role="group"] button').nth(2);
    await strict.tap();
    await expect(strict).toHaveAttribute('aria-pressed', 'true');
  });
});
