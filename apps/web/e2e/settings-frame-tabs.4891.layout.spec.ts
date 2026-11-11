/**
 * story 4891 (UI-8 · settings frame + four tabs) — the settings list (the phone's first screen) with the legal footer, the API-keys and account-danger cards, the project list with its «new project» form (and a row being edited), the support chat body (a conversation with
 * every kind of line · an ended conversation with a failed send · the error state) and the four confirmations (organization delete — impact read / not read · project delete · account delete — what closes with it and what blocks), measured in Chromium on a touch phone
 * (390 × 844): the REAL components (bundled with esbuild, not copied) and the real Tailwind build. Rule: every press is ≥ 44 × 44, no visible text is under 12 px, nothing runs past the width, no old (non-ds) part is drawn.
 * Also: the selected row of the list is tinted side by side (1280) and NOT on the phone's full-screen list (390).
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
        import { Tabs as TabsPrimitive } from '@base-ui/react/tabs';
        import ko from './messages/ko.json';
        import { SettingsNav } from './src/app/(authenticated)/settings/settings-nav-list';
        import { settingsNavGroups } from './src/app/(authenticated)/settings/settings-nav';
        import { LegalLinks, BusinessInfoBlock } from './src/components/legal/legal-footer';
        import { ApiKeysMovedCard } from './src/components/settings/api-keys-moved-card';
        import { AccountDangerSection } from './src/components/settings/account-danger-section';
        import { ProjectsSection } from './src/components/settings/projects-section';
        import { SettingsSection } from './src/components/settings/settings-section';
        import { SupportWidgetPanelBody } from './src/components/support-widget/support-widget-panel';
        import { OrgDeleteDialog } from './src/components/settings/org-delete-dialog';
        import { ProjectDeleteDialog } from './src/components/settings/project-delete-dialog';
        import { DeleteAccountDialog } from './src/components/settings/delete-account-dialog';

        const noop = () => {};
        const groups = settingsNavGroups({ adminChecked: true, isAdmin: true, inPhoneApp: false, supportWidget: true, billing: true });
        const projects = [{ id: 'p1', name: '알파', description: '첫째 프로젝트의 아주 긴 설명이 이어져서 한 줄을 넘어갑니다 한 줄을 넘어갑니다' }, { id: 'p2', name: '아주 긴 이름을 가진 베타 프로젝트 아주 긴 이름', description: null }, { id: 'p3', name: '감마', description: '' }];
        const session = (over) => ({ status: 'ready', sending: false, sendError: null, isEnded: false, conversationId: 'c1', conversations: [{ id: 'c1', created_at: new Date().toISOString(), ended_at: null }], escalationStatus: null,
          messages: [
            { id: 'm1', role: 'user', content: '결제 수단을 바꾸고 싶은데 어디서 하나요? 아주 긴 문장이 이어지면 줄이 바뀌어야 합니다 아주 긴 문장이 이어지면' },
            { id: 'm2', role: 'agent', content: '설정의 결제 구역에서 바꿀 수 있어요.', escalated: true },
            { id: 'm3', role: 'operator', content: '담당자가 이어서 답변드려요.' },
            { id: 'm4', role: 'user', content: '안 보내진 메시지', failed: true },
            { id: 'm5', role: 'user', content: '보내는 중', pending: true },
          ],
          connect: noop, startNewConversation: noop, loadConversations: noop, selectConversation: noop, viewActiveConversation: noop, endConversation: noop, retryLastMessage: noop, sendMessage: noop, ...over });
        function SupportBox({ id, s }) {
          return React.createElement('div', { id, className: 'flex h-[32rem] flex-col overflow-hidden rounded-ds-control border border-ds-line bg-ds-surface' }, React.createElement(SupportWidgetPanelBody, { session: s }));
        }
        function Harness() {
          const [open, setOpen] = React.useState('');
          const [editing, setEditing] = React.useState(null);
          return React.createElement('div', { style: { padding: '16px' }, className: 'space-y-4' },
            ['org', 'org-fail', 'project', 'account'].map((k) => React.createElement('button', { key: k, id: 'open-' + k, onClick: () => setOpen(k) }, 'open ' + k)),
            React.createElement('div', { id: 'frame' },
              React.createElement(TabsPrimitive.Root, { value: 'projects' }, React.createElement(SettingsNav, { groups, activeTab: 'projects', integrationsHref: '/settings/integrations' })),
              React.createElement('div', { className: 'mt-8 border-t border-ds-line pt-6' },
                React.createElement('h2', { className: 'mb-3 text-ds-small font-semibold text-ds-ink' }, '이용약관 및 정책'),
                React.createElement(LegalLinks, { className: 'justify-start text-ds-body text-ds-ink-3' }),
                React.createElement('div', { className: 'mt-4 border-t border-ds-line pt-4' }, React.createElement(BusinessInfoBlock, { className: 'justify-start text-ds-small text-ds-ink-3' })))),
            React.createElement('div', { id: 'cards', className: 'space-y-4' }, React.createElement(ApiKeysMovedCard), React.createElement(AccountDangerSection, { onOpenDelete: () => setOpen('account') })),
            React.createElement('div', { id: 'projects' }, React.createElement(ProjectsSection, { projects, currentProjectId: 'p1', isAdmin: true, editingId: editing, editName: '알파 둘', editDescription: '설명', saving: false,
              onEditStart: (p) => setEditing(p.id), onEditName: noop, onEditDescription: noop, onEditSave: noop, onEditCancel: () => setEditing(null), deletingId: null, onDeleteAsk: () => setOpen('project'),
              message: { type: 'success', text: '프로젝트를 만들고 작업 공간에 바로 반영했어요.' }, newName: '', newDescription: '', creating: false, onNewName: noop, onNewDescription: noop, onCreate: noop })),
            React.createElement('div', { id: 'support' },
              React.createElement(SettingsSection, { title: '문의 · 고객지원', description: '무엇이든 물어보세요' },
                React.createElement(SupportBox, { id: 'support-ready', s: session({ escalationStatus: 'open' }) })),
              React.createElement('div', { className: 'mt-4' }, React.createElement(SupportBox, { id: 'support-ended', s: session({ isEnded: true, sendError: '메시지를 보내지 못했어요. 다시 시도해 주세요.' }) })),
              React.createElement('div', { className: 'mt-4' }, React.createElement(SupportBox, { id: 'support-error', s: session({ status: 'error', messages: [] }) }))),
            open === 'org' ? React.createElement(OrgDeleteDialog, { orgName: '우리 조직', impact: { project_count: 2, member_count: 5, has_active_subscription: true }, impactLoading: false, confirmName: '', onConfirmName: noop, confirmWithoutImpact: false, onConfirmWithoutImpact: noop, deleting: false, canSubmit: false, onRetryImpact: noop, onClose: () => setOpen(''), onConfirm: noop }) : null,
            open === 'org-fail' ? React.createElement(OrgDeleteDialog, { orgName: '우리 조직', impact: null, impactLoading: false, confirmName: '', onConfirmName: noop, confirmWithoutImpact: false, onConfirmWithoutImpact: noop, deleting: false, canSubmit: false, onRetryImpact: noop, onClose: () => setOpen(''), onConfirm: noop }) : null,
            open === 'project' ? React.createElement(ProjectDeleteDialog, { deleting: false, onClose: () => setOpen(''), onConfirm: noop }) : null,
            open === 'account' ? React.createElement(DeleteAccountDialog, { onClose: () => setOpen(''), onDeleted: noop }) : null);
        }
        window.__mount = () => {
          window.__dashboardCtx = { currentMemberType: 'human' };
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
  const candidates = [...new Set([...js.matchAll(/"([^"\n]+)"/g)].flatMap((m) => m[1]!.split(/\s+/)).filter(Boolean))];
  const compiler = await compile(readFileSync(path.join(APP, 'globals.css'), 'utf8'), { base: APP, onDependency: () => {} });
  const css = (optimize as unknown as (c: string, o?: object) => { code: string })(compiler.build(candidates), { minify: false }).code;
  built = { js, css };
  return built;
}

async function open(page: Page) {
  const { js, css } = await build();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.unrouteAll();
  await page.route('http://preview.test/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/') {
      return route.fulfill({ contentType: 'text/html', body: `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head><body class="bg-ds-canvas text-ds-ink"><div id="root"></div></body></html>` });
    }
    if (url.pathname === '/api/account/delete-preview') {
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ data: {
        closing: [{ id: 'o1', name: '혼자 쓰는 조직' }],
        blocked: [{ id: 'o2', name: '둘이 쓰는 조직', reason: 'other_members' }, { id: 'o3', name: '구독 중인 조직', reason: 'active_subscription' }],
      } }) });
    }
    return route.fulfill({ status: 404, body: '{}' });
  });
  await page.addInitScript(() => { (window as unknown as { process: unknown }).process = { env: {} }; });
  await page.goto('about:blank');
  await page.goto('http://preview.test/');
  await page.addScriptTag({ content: js });
  await page.evaluate(() => (window as unknown as { __mount: () => void }).__mount());
  await page.locator('#frame [data-settings-tab]').first().waitFor();
}

const measure = (page: Page, scope = 'body') => page.evaluate((sel) => {
  const root = document.querySelector(sel)!;
  const vis = (e: Element) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== 'hidden' && !e.closest('[aria-hidden="true"]'); };
  const isOpener = (e: Element) => e.id.startsWith('open-');
  const presses = [...root.querySelectorAll('button, [role=switch], a[href], input, select, summary, [role=tab], label[data-slot="ds-checkbox-field"]')].filter((e) => vis(e) && !isOpener(e));
  const small = presses.filter((e) => { const r = e.getBoundingClientRect(); return r.width < 43.5 || r.height < 43.5; }).map((e) => `${(e.getAttribute('aria-label') || e.textContent || e.tagName).trim().slice(0, 18)} ${Math.round(e.getBoundingClientRect().width)}x${Math.round(e.getBoundingClientRect().height)}`);
  const leaves = [...root.querySelectorAll('*')].filter((e) => e.children.length === 0 && (e.textContent || '').trim() && vis(e) && !isOpener(e) && !e.closest('[data-slot="ds-count-badge"]'));
  const tiny = leaves.filter((e) => parseFloat(getComputedStyle(e).fontSize) < 12).map((e) => `${(e.textContent || '').trim().slice(0, 14)} ${getComputedStyle(e).fontSize}`);
  return {
    presses: presses.length, small, tiny, overflowX: document.documentElement.scrollWidth > innerWidth + 1,
    // named exemption: the ds Dialog draws its overlay with the shared overlay part (slot `dialog-overlay`) — the ds part's own inside
    oldSlots: [...root.querySelectorAll('[data-slot]')].map((e) => e.getAttribute('data-slot')!).filter((s) => !s.startsWith('ds-') && s !== 'dialog-overlay'),
    oldClasses: [...root.querySelectorAll('[class]')].filter((e) => /(^|\s)(text-xs|text-sm|text-muted-foreground|text-foreground|text-destructive|text-micro|text-editorial-meta)(\s|$)/.test(e.getAttribute('class') || '')).map((e) => (e.getAttribute('class') || '').slice(0, 60)),
  };
}, scope);
async function expectClean(page: Page, label: string, scope = 'body') {
  const m = await measure(page, scope);
  expect(m.small, `${label}: presses under 44 px: ${m.small.join(' · ')}`).toEqual([]);
  expect(m.tiny, `${label}: text under 12 px: ${m.tiny.join(' · ')}`).toEqual([]);
  expect(m.overflowX, `${label}: overflow`).toBe(false);
  expect(m.oldSlots, `${label}: old (non-ds) parts drawn`).toEqual([]);
  expect(m.oldClasses, `${label}: old text classes drawn`).toEqual([]);
  return m;
}

test.describe('on a touch phone (390 × 844)', () => {
  test.use({ hasTouch: true, isMobile: true });

  test('[SID:4891] the settings list and its legal footer stand clean; the selected row is NOT tinted on the phone list', async ({ page }) => {
    await open(page);
    const m = await expectClean(page, 'frame', '#frame');
    expect(m.presses).toBeGreaterThan(12); // the rows + the three policy links
    const active = page.locator('#frame [data-settings-tab="projects"]');
    await expect(active).toHaveAttribute('aria-current', 'true');
    const bg = (loc: typeof active) => loc.evaluate((e) => getComputedStyle(e).backgroundColor);
    expect(await bg(active), 'a tinted row on the phone list points at nothing').toBe('rgba(0, 0, 0, 0)');
    await page.setViewportSize({ width: 1280, height: 800 });
    // the row's colour change runs 100 ms (transition-colors): wait for it to settle instead of reading mid-way
    await expect.poll(() => bg(active), { message: 'side by side (≥ lg) the selected row is tinted' }).not.toBe('rgba(0, 0, 0, 0)');
  });

  test('[SID:4891] the API-keys card and the account danger card stand clean', async ({ page }) => {
    await open(page);
    const m = await expectClean(page, 'cards', '#cards');
    expect(m.presses).toBe(2);
  });

  test('[SID:4891] the project list with the «new project» form (rows · long names · current tag · result line) and a row being edited stand clean', async ({ page }) => {
    await open(page);
    const m = await expectClean(page, 'projects', '#projects');
    expect(m.presses).toBeGreaterThan(6); // three rows × (edit + delete) + the two boxes + create
    await page.getByRole('button', { name: /^수정 — 알파$/ }).tap();
    await expectClean(page, 'projects, a row being edited', '#projects');
    await expect(page.getByRole('textbox', { name: '프로젝트 이름' })).toHaveCount(2);
  });

  test('[SID:4891] the support chat body: a conversation with every kind of line · an ended one with a failed send · the error state stand clean', async ({ page }) => {
    await open(page);
    for (const id of ['#support-ready', '#support-ended', '#support-error']) {
      await page.locator(id).scrollIntoViewIfNeeded();
      await expectClean(page, id, id);
    }
    await expect(page.locator('#support-ended [data-slot="ds-banner"][role="alert"]')).toContainText('메시지를 보내지 못했어요');
    await expect(page.locator('#support-error').getByRole('button', { name: '다시 연결' })).toBeVisible();
  });

  for (const [key, label, expectText] of [
    ['org', 'organization delete — impact read', '프로젝트 2개 영구 삭제'],
    ['org-fail', 'organization delete — impact not read', '다시 시도'],
    ['project', 'project delete', '되돌릴 수 없어요'],
    ['account', 'account delete', '함께 삭제되는 조직'],
  ] as const) {
    test(`[SID:4891] the confirmation «${label}» stands clean`, async ({ page }) => {
      await page.emulateMedia({ reducedMotion: 'reduce' }); // the dialog's zoom-in would be measured mid-way (95 % of 44 px = 42)
      await open(page);
      await page.locator(`#open-${key}`).evaluate((e) => (e as HTMLElement).click());
      const dlg = page.locator('[data-slot="ds-dialog-content"]');
      await dlg.waitFor();
      await expect(dlg).toContainText(expectText);
      await expectClean(page, label, '[data-slot="ds-dialog-content"]');
      if (key === 'account') {
        await expect(dlg.locator('[data-testid="delete-account-blocking-orgs"] li')).toHaveCount(2);
        await expect(page.getByRole('button', { name: '삭제 확인' })).toBeDisabled(); // an organization blocks: the button is off
      }
    });
  }
});
