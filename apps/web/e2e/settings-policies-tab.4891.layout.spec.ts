/**
 * story 4891 (UI-8 · «결재 라인 정책» tab) — the line editor (four modes: 보기 with the active-line card and the dry-run simulator · 편집 with a draft, its JSON box and a failed lint · 이력 with all five version states · 변경 비교),
 * a failed press (the alert line) and the settings card around it, measured in Chromium on a touch phone (390 × 844): the REAL components (bundled with esbuild, not copied) and the real Tailwind build.
 * Rule: every press is ≥ 44 × 44, no visible text is under 12 px, nothing runs past the width, no old (non-ds) part is drawn, every box has a name.
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
        import { SettingsSection } from './src/components/settings/settings-section';
        import { WorkflowLineEditorSection } from './src/components/settings/workflow-line-editor-section';
        window.__mount = () => {
          createRoot(document.getElementById('root')).render(React.createElement(NextIntlClientProvider, { locale: 'ko', messages: ko, timeZone: 'Asia/Seoul' },
            React.createElement('div', { style: { padding: '16px' } },
              React.createElement(SettingsSection, { title: ko.settings.tabWorkflowPolicies, description: ko.settings.workflowPoliciesDescription, id: 'workflow-policies' },
                React.createElement(WorkflowLineEditorSection, { projectId: 'p1' })))));
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

const VERSIONS = [
  { id: 'v1', version: 1, status: 'published', lint_status: 'passed', updated_at: '2026-11-01T00:00:00Z', config: { steps: [{ from_status: 'todo', to_status: 'done' }, { from_status: 'done', to_status: 'a-very-long-status-name-that-must-wrap-somewhere' }] } },
  { id: 'v2', version: 2, status: 'draft', lint_status: 'pending', updated_at: '2026-11-02T00:00:00Z', config: { steps: [{ from_status: 'todo', to_status: 'doing' }] } },
  { id: 'v3', version: 3, status: 'pending_publish', lint_status: 'passed', updated_at: '2026-11-03T00:00:00Z', config: { steps: [] } },
  { id: 'v4', version: 4, status: 'rejected', lint_status: 'failed', updated_at: '2026-11-04T00:00:00Z', config: { steps: [] } },
  { id: 'v5', version: 5, status: 'retired', lint_status: 'passed', updated_at: '2026-11-05T00:00:00Z', config: { steps: [] } },
];

let failCreate = false;
async function open(page: Page) {
  const { js, css } = await build();
  failCreate = false;
  await page.setViewportSize({ width: 390, height: 844 });
  await page.unrouteAll();
  await page.route('http://preview.test/**', async (route) => {
    const url = new URL(route.request().url());
    const method = route.request().method();
    const ok = (data: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(data) });
    if (url.pathname === '/') {
      return route.fulfill({ contentType: 'text/html', body: `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head><body class="bg-ds-background text-ds-ink"><div id="root"></div></body></html>` });
    }
    if (url.pathname === '/api/workflow-line-config/versions' && method === 'GET') return ok(VERSIONS);
    if (url.pathname === '/api/workflow-line-config/versions' && method === 'POST') return failCreate ? ok({}, 500) : ok(VERSIONS[1]);
    if (url.pathname === '/api/workflow-line-config/active') return ok({ entity_type: 'story', has_active: true, config: VERSIONS[0]!.config });
    if (/\/api\/workflow-line-config\/versions\/[\w-]+\/lint$/.test(url.pathname)) return ok({ lint_status: 'failed', errors: [{ message: '단계 하나가 비었어요 — to_status가 필요해요 (아주 긴 안내가 이어지면 줄이 바뀌어야 합니다)' }, { message: '두 번째 안내' }] });
    if (/\/api\/workflow-line-config\/versions\/[\w-]+$/.test(url.pathname)) return ok(VERSIONS[1]);
    if (url.pathname === '/api/workflow-line-config/resolve-preview') {
      return ok({ mode: 'enforce', proceeds: false, matched: true, blocking_reason: '정책에 막혔어요 — 사람의 결재가 필요해요', routing_path: [{ from_status: 'todo', to_status: 'merged', route: 'review-then-merge' }, { from_status: null, to_status: 'done', route: null }], gates: [{ gate_type: 'human', target: 'a-long-target-name', gate_id: 'g1' }, { gate_type: 'policy', target: null, gate_id: 'g2' }, { gate_type: 'merge', target: 'po', gate_id: null }], trust_branch: { trust: 0.82, decision: 'ask_human', cold_start: true } });
    }
    return ok(null, 404);
  });
  await page.addInitScript(() => { (window as unknown as { process: unknown }).process = { env: {} }; });
  await page.goto('about:blank');
  await page.goto('http://preview.test/');
  await page.addScriptTag({ content: js });
  await page.evaluate(() => (window as unknown as { __mount: () => void }).__mount());
  await page.getByRole('tab', { name: '보기' }).waitFor();
  await page.waitForTimeout(300); // the reads settle
}

const measure = (page: Page) => page.evaluate(() => {
  const root = document.querySelector('#root')!;
  const vis = (e: Element) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== 'hidden' && !e.closest('[aria-hidden="true"]'); };
  const presses = [...root.querySelectorAll('button, a[href], input, select, textarea, summary, [role=tab], [role=switch]')].filter(vis);
  const small = presses.filter((e) => { const r = e.getBoundingClientRect(); return r.width < 43.5 || r.height < 43.5; }).map((e) => `${(e.getAttribute('aria-label') || e.textContent || e.tagName).trim().slice(0, 18)} ${Math.round(e.getBoundingClientRect().width)}x${Math.round(e.getBoundingClientRect().height)}`);
  const leaves = [...root.querySelectorAll('*')].filter((e) => e.children.length === 0 && (e.textContent || '').trim() && vis(e));
  const tiny = leaves.filter((e) => parseFloat(getComputedStyle(e).fontSize) < 12).map((e) => `${(e.textContent || '').trim().slice(0, 14)} ${getComputedStyle(e).fontSize}`);
  const unnamed = [...root.querySelectorAll('input, select, textarea')].filter(vis).filter((e) => !(e.getAttribute('aria-label') || e.getAttribute('aria-labelledby') || ((e as HTMLInputElement).labels?.length ?? 0) > 0)).map((e) => e.tagName);
  // named exemption: the ds Dialog's overlay part
  const oldSlots = [...root.querySelectorAll('[data-slot]')].map((e) => e.getAttribute('data-slot')!).filter((s) => !s.startsWith('ds-') && s !== 'dialog-overlay');
  const oldClasses = [...root.querySelectorAll('[class]')].filter((e) => /(^|\s)(text-xs|text-sm|text-muted-foreground|text-foreground|text-destructive|bg-muted|border-border)(\s|$)/.test(e.getAttribute('class') || '')).map((e) => (e.getAttribute('class') || '').slice(0, 60));
  return { presses: presses.length, small, tiny, unnamed, oldSlots, oldClasses, overflowX: document.documentElement.scrollWidth > innerWidth + 1 };
});
async function expectClean(page: Page, label: string) {
  const m = await measure(page);
  expect(m.small, `${label}: presses under 44 px: ${m.small.join(' · ')}`).toEqual([]);
  expect(m.tiny, `${label}: text under 12 px: ${m.tiny.join(' · ')}`).toEqual([]);
  expect(m.unnamed, `${label}: boxes without a name`).toEqual([]);
  expect(m.overflowX, `${label}: overflow`).toBe(false);
  expect(m.oldSlots, `${label}: old (non-ds) parts drawn`).toEqual([]);
  expect(m.oldClasses, `${label}: old text/colour classes drawn`).toEqual([]);
  return m;
}

test.describe('on a touch phone (390 × 844)', () => {
  test.use({ hasTouch: true, isMobile: true });

  test('[SID:4891] 보기: the mode tabs, the entity-type box, the active line and the simulator (before and after a run with every kind of result) stand clean', async ({ page }) => {
    await open(page);
    const m = await expectClean(page, 'view');
    expect(m.presses).toBeGreaterThan(8); // 4 tabs · 2 selects · 3 inputs + select · run
    await page.getByRole('textbox', { name: '엔티티 ID' }).fill('11111111-2222-3333-4444-555555555555');
    await page.getByRole('textbox', { name: '다음 상태' }).fill('merged');
    await page.getByRole('button', { name: '미리보기' }).tap();
    await expect(page.getByText('라우팅 경로')).toBeVisible();
    await expectClean(page, 'view, after a run');
  });

  test('[SID:4891] 편집: no draft yet · a draft with its JSON box · a failed lint with long messages stand clean', async ({ page }) => {
    await open(page);
    await page.getByRole('tab', { name: '편집' }).tap();
    await expectClean(page, 'edit, no draft');
    await page.getByRole('button', { name: '새 초안' }).tap();
    await expect(page.getByRole('textbox', { name: '편집' })).toBeVisible();
    await expectClean(page, 'edit, a draft');
    await page.getByRole('button', { name: '검사', exact: true }).tap();
    await expect(page.getByText('검사 실패')).toBeVisible();
    await expectClean(page, 'edit, a failed lint');
  });

  test('[SID:4891] 이력: all five version states (and the one draft row’s «n번째 버전 편집») stand clean', async ({ page }) => {
    await open(page);
    await page.getByRole('tab', { name: '이력' }).tap();
    await expect(page.getByText('pending_publish')).toBeVisible();
    const m = await expectClean(page, 'history');
    expect(m.presses).toBeGreaterThan(5);
    await expect(page.getByRole('button', { name: '2번째 버전 편집' })).toBeVisible();
  });

  test('[SID:4891] 변경 비교: a draft against the active line (added · removed · changed) stands clean', async ({ page }) => {
    await open(page);
    await page.getByRole('tab', { name: '편집' }).tap();
    await page.getByRole('button', { name: '새 초안' }).tap();
    await expect(page.getByRole('textbox', { name: '편집' })).toBeVisible();
    await page.getByRole('tab', { name: '변경 비교' }).tap();
    await expect(page.getByText('todo→doing')).toBeVisible();
    await expectClean(page, 'diff');
  });

  test('[SID:4891] a failed press says so in an alert line that stands clean', async ({ page }) => {
    await open(page);
    failCreate = true;
    await page.getByRole('tab', { name: '편집' }).tap();
    await page.getByRole('button', { name: '새 초안' }).tap();
    await expect(page.getByRole('alert')).toContainText('초안 생성에 실패했어요');
    await expectClean(page, 'failed press');
  });
});
