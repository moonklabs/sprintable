/**
 * story 4891 (UI-8 · settings › 프로젝트 접근 · piece ⑤c) — the project-access list (granted · blocked · owner rows), the per-member webhook card (saved · empty · error rows) and the add-member dialog, measured in Chromium on a touch phone (390 × 844):
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
        import { ProjectAccessSection } from './src/components/settings/project-access-section';
        import { MemberWebhooksSection } from './src/components/settings/member-webhooks-section';
        import { AddMemberModal } from './src/components/settings/add-member-modal';
        const labels = new Map([['h-1', '아주 긴 이름을 가진 사람 아주 긴 이름'], ['h-2', '하나'], ['h-3', '셋']]);
        function Harness() {
          const [open, setOpen] = React.useState(false);
          return React.createElement('div', { style: { padding: '16px' }, className: 'space-y-4' },
            React.createElement('button', { id: 'open-add', onClick: () => setOpen(true) }, 'open'),
            React.createElement(ProjectAccessSection, { projectId: 'p-1' }),
            React.createElement(MemberWebhooksSection, { members: [{ id: 'h-1' }, { id: 'h-2' }, { id: 'h-3' }],
              webhooks: [{ member_id: 'h-1', url: 'https://hooks.example.com/a/very/long/address/that/keeps/going/and/going', is_active: true }, { member_id: 'h-2', url: 'https://hooks.example.com/b', is_active: false }],
              editing: {}, errors: { 'h-3': '주소가 올바르지 않아요' }, savingId: null, rowLabels: labels, onEdit: () => {}, onSave: () => {} }),
            React.createElement(AddMemberModal, { open, onClose: () => setOpen(false), orgId: 'org-1', projects: [{ id: 'p1', name: '알파' }, { id: 'p2', name: '베타 프로젝트의 아주 긴 이름' }], onAdded: () => {} }));
        }
        window.__mount = () => {
          createRoot(document.getElementById('root')).render(React.createElement(NextIntlClientProvider, { locale: 'ko', messages: ko, timeZone: 'Asia/Seoul' }, React.createElement(Harness)));
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

let posted: { url: string; body: unknown }[] = [];
async function open(page: Page) {
  const { js, css } = await build();
  posted = [];
  await page.setViewportSize({ width: 390, height: 844 });
  await page.unrouteAll();
  await page.route('http://preview.test/**', async (route) => {
    const url = new URL(route.request().url());
    const method = route.request().method();
    const json = (data: unknown) => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ data }) });
    if (url.pathname === '/') {
      return route.fulfill({ contentType: 'text/html', body: `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head><body class="bg-ds-canvas text-ds-ink"><div id="root"></div></body></html>` });
    }
    if (url.pathname === '/api/projects/p-1/access-candidates') {
      return json([
        { id: 'm-owner', user_id: 'u-o', name: '오너', email: 'owner@example.com', role: 'owner' },
        { id: 'm-admin', user_id: 'u-a', name: '아주 긴 이름을 가진 관리자 아주 긴 이름', email: 'a-very-long-address-for-an-admin@example.com', role: 'admin' },
        { id: 'm-member', user_id: 'u-m', name: '구성원', email: 'm@example.com', role: 'member' },
      ]);
    }
    if (url.pathname === '/api/projects/p-1/access' && method === 'POST') { posted.push({ url: url.pathname, body: JSON.parse(route.request().postData() ?? '{}') }); return json({}); }
    if (url.pathname === '/api/projects/p-1/access') return json([{ id: 'g-admin', org_member_id: 'm-admin', role: 'admin' }]);
    if (url.pathname === '/api/organizations/org-1/invites' && method === 'POST') { posted.push({ url: url.pathname, body: JSON.parse(route.request().postData() ?? '{}') }); return json({ invite_url: 'u' }); }
    return route.fulfill({ status: 404, body: '{}' });
  });
  await page.addInitScript(() => { (window as unknown as { process: unknown }).process = { env: {} }; });
  await page.goto('about:blank');
  await page.goto('http://preview.test/');
  await page.addScriptTag({ content: js });
  await page.evaluate(() => (window as unknown as { __mount: () => void }).__mount());
  await page.getByRole('button', { name: '들어감', exact: true }).waitFor();
}

const measure = (page: Page) => page.evaluate(() => {
  const vis = (e: Element) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== 'hidden' && !e.closest('[aria-hidden="true"]'); };
  const presses = [...document.querySelectorAll('button:not(#open-add), [role=switch], a[href], input, select, summary')].filter(vis);
  const small = presses.filter((e) => { const r = e.getBoundingClientRect(); return r.width < 43.5 || r.height < 43.5; }).map((e) => `${(e.getAttribute('aria-label') || e.textContent || e.tagName).trim().slice(0, 14)} ${Math.round(e.getBoundingClientRect().width)}x${Math.round(e.getBoundingClientRect().height)}`);
  // named exemption: the ds CountBadge is 11 px mono by the UI-3 spec (a number beside the title, not reading text)
  const leaves = [...document.querySelectorAll('body *')].filter((e) => e.children.length === 0 && (e.textContent || '').trim() && vis(e) && e.id !== 'open-add' && !e.closest('[data-slot="ds-count-badge"]'));
  const tiny = leaves.filter((e) => parseFloat(getComputedStyle(e).fontSize) < 12).map((e) => `${(e.textContent || '').trim().slice(0, 14)} ${getComputedStyle(e).fontSize}`);
  // a row whose actions run past its own right edge
  const clipped = [...document.querySelectorAll('.divide-y > div')].filter((row) => { const rr = row.getBoundingClientRect(); return [...row.querySelectorAll('button, input')].some((c) => !c.closest('[aria-hidden="true"]') && c.getBoundingClientRect().right > rr.right + 0.5); }).length;
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

  test('[SID:4891] the project-access list (owner · granted · blocked rows) and the webhook card (saved · inactive · empty + error row) stand clean', async ({ page }) => {
    await open(page);
    const m = await expectClean(page, 'members tab');
    expect(m.presses).toBeGreaterThan(6); // two toggles + three address boxes + three saves (+ the harness opener, exempt)
    await expect(page.getByRole('textbox', { name: / — 셋$/ })).toBeVisible();
    await expect(page.getByRole('alert')).toHaveText('주소가 올바르지 않아요');
  });

  test('[SID:4891] a toggle press reaches its request (allow the blocked member with their org role)', async ({ page }) => {
    await open(page);
    await page.getByRole('button', { name: '안 들어감' }).tap();
    await expect.poll(() => posted).toEqual([{ url: '/api/projects/p-1/access', body: { org_member_id: 'm-member', role: 'member' } }]);
    await expect(page.getByRole('status')).toBeVisible();
    await expectClean(page, 'after a toggle');
  });

  test('[SID:4891] the add-member dialog (ds Dialog): email · «역할» select · project chips · both buttons ≥44, chips press', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' }); // the dialog's zoom-in would be measured mid-way (95 % of 44 px = 42)
    await open(page);
    await page.locator('#open-add').tap();
    const dlg = page.locator('[data-slot="ds-dialog-content"]');
    await dlg.waitFor();
    await expect(dlg.getByRole('combobox', { name: '역할' })).toBeVisible();
    await dlg.getByRole('button', { name: '알파' }).tap();
    await expect(dlg.getByRole('button', { name: '알파' })).toHaveAttribute('aria-pressed', 'true');
    await expectClean(page, 'add-member dialog');
    await dlg.getByRole('button', { name: '구성원 추가', exact: true }).tap();
    await expect(dlg.getByRole('alert')).toBeVisible();
    await expectClean(page, 'add-member dialog with the empty-email alert');
  });
});
