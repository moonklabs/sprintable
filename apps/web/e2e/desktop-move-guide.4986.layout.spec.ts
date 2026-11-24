/**
 * story 4986 AC5 — the web's «옮기기 안내», drawn by the REAL components with the real Tailwind build and the real words, light and dark: ① the move panel's «옮긴 뒤에 알아 둘 것» block
 * (DesktopSetup, the move way chosen) · ② the finished move's old-computer line + [연결된 기기 보기] (SetupProgressView) · ③ «연결된 기기» with a computer that has no agent left («에이전트가 없는
 * 컴퓨터예요 — 끊어도 돼요»). Only the API answers are made up. Asserted: nothing wider than the screen, no text cut off in its box. With CAPTURE_OUT set, the captures are written there.
 */
import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { expect, test, type Page } from '@playwright/test';
import { compile, optimize } from '@tailwindcss/node';
import { layoutStubPlugin } from './support/layout-stubs';
import { tailwindCandidates } from './support/tailwind-candidates';

const req = createRequire(__filename);
const WEB = path.join(__dirname, '..');
const APP = path.join(WEB, 'src', 'app');
const CODE = `${'A'.repeat(20)}_-${'b'.repeat(21)}`;

let built: { js: string; css: string } | null = null;
async function build() {
  if (built) return built;
  const esbuild = req('esbuild') as typeof import('esbuild');
  const out = await esbuild.build({
    stdin: {
      contents: `
        import React from 'react'; import { createRoot } from 'react-dom/client'; import { NextIntlClientProvider } from 'next-intl';
        import ko from './messages/ko.json'; import en from './messages/en.json';
        import { DesktopSetup } from './src/components/desktop/desktop-setup';
        import { SetupProgressView } from './src/components/desktop/desktop-setup-progress';
        import { DesktopDevices } from './src/components/desktop/desktop-devices';
        window.__mount = (locale, which) => {
          const body = which === 'panel' ? React.createElement(DesktopSetup, { code: ${JSON.stringify(CODE)}, runtimes: ['claude', 'codex'], canMove: true })
            : which === 'done' ? React.createElement(SetupProgressView, { setupId: 's-1', recipeName: '' })
            : React.createElement(DesktopDevices);
          createRoot(document.getElementById('root')).render(React.createElement(NextIntlClientProvider, { locale, messages: locale === 'en' ? en : ko, timeZone: 'Asia/Seoul' },
            React.createElement('div', { className: 'mx-auto w-full max-w-2xl p-4' }, body)));
        };`,
      resolveDir: WEB, loader: 'tsx',
    },
    bundle: true, format: 'iife', platform: 'browser', write: false, logLevel: 'silent', jsx: 'automatic',
    tsconfig: path.join(WEB, 'tsconfig.json'),
    define: { 'process.env.NODE_ENV': '"production"', 'process.env.NEXT_PUBLIC_APP_URL': '"https://app.sprintable.ai"' },
    plugins: [layoutStubPlugin()],
  });
  const js = out.outputFiles[0]!.text;
  const compiler = await compile(readFileSync(path.join(APP, 'globals.css'), 'utf8'), { base: APP, onDependency: () => {} });
  const css = (optimize as unknown as (c: string, o?: object) => { code: string })(compiler.build(tailwindCandidates(js)), { minify: false }).code;
  built = { js, css };
  return built;
}

const PROJ = '11111111-1111-4111-8111-111111111111';
const AGENTS = [
  { id: 'a-dan', name: '결제 담당', runtime: 'claude', live_keys: 1, last_used_at: new Date(Date.now() - 5 * 60_000).toISOString(), in_project: true },
  { id: 'a-kad', name: '리뷰 도우미', runtime: 'codex', live_keys: 0, last_used_at: null, in_project: true },
];
const STATUS = {
  state: 'handed_over', recipe_name: null, recipe: null, work_item_id: null, setup_kind: 'move',
  members: [{ stage: null, role: null, member_id: 'a-dan', kind: 'agent', runtime: 'claude', name: '결제 담당' }, { stage: null, role: null, member_id: 'a-kad', kind: 'agent', runtime: 'codex', name: '리뷰 도우미' }],
  signals: { tools_connected: [{ member_id: 'a-dan', at: '2026-11-20T04:41:00Z' }, { member_id: 'a-kad', at: '2026-11-20T04:41:02Z' }], first_task_handed_at: null, first_result_at: null, workdir_fallback_at: null, blocked: null },
};
const sid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const setup = (n: number, name: string, over: Record<string, unknown> = {}) => ({
  setup_id: sid(n), device_name: name, state: 'handed_over', confirmed_at: '2026-11-19T01:00:00Z', confirmed_by_name: '김지우', revoked_at: null, revoked_by_name: null,
  active_keys: 1, paired_phones: 0, members: [{ kind: 'agent', member_id: `a${n}`, name: '결제 담당', role: 'Dev' }], ...over,
});
const COMPUTERS = { truncated: false, computers: [
  { computer_id: 'c1111111-1111-4111-8111-111111111111', device_name: '새 맥북', state: 'handed_over', confirmed_by_name: '김지우', confirmed_at: '2026-11-20T01:00:00Z', last_used_at: null, live_setups: 1, active_keys: 1, setups: [setup(1, '새 맥북')] },
  { computer_id: 'c2222222-2222-4222-8222-222222222222', device_name: '옛 맥 스튜디오', state: 'handed_over', confirmed_by_name: '김지우', confirmed_at: '2026-11-19T01:00:00Z', last_used_at: null, live_setups: 1, active_keys: 0, setups: [setup(2, '옛 맥 스튜디오', { members: [], active_keys: 0 })] },
] };

async function open(page: Page, o: { theme: 'L' | 'D'; locale: 'ko' | 'en'; w: number; which: 'panel' | 'done' | 'devices' }) {
  const { js, css } = await build();
  await page.setViewportSize({ width: o.w, height: 900 });
  await page.unrouteAll();
  await page.route('http://preview.test/**', async (route) => {
    const url = new URL(route.request().url());
    const json = (b: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(b) });
    if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: `<!doctype html><html lang="${o.locale}" class="${o.theme === 'D' ? 'dark' : ''}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head><body class="bg-background text-foreground"><div id="root"></div></body></html>` });
    if (url.pathname === '/api/desktop/recipes') return json({ recipes: [{ id: 'rec-1', key: 'org.research_one', name: '조사 한 명', roles: [{ role: '조사', kind: 'agent', stages: ['research'] }] }], agent_room: null, project_room: null });
    if (url.pathname === '/api/desktop/setup/agents') return json({ agents: AGENTS });
    if (url.pathname.startsWith('/api/desktop/setups/')) return json(STATUS);
    if (url.pathname === '/api/desktop/computers') return json(COMPUTERS);
    if (/^\/api\/organizations\/[^/]+\/remote-control$/.test(url.pathname)) return json({ data: { enabled: true, can_change: true, enabled_at: null } });
    return json({}, 404);
  });
  await page.addInitScript(([p]) => {
    (window as unknown as { process: unknown }).process = { env: {} };
    (window as unknown as { __dashboardCtx: unknown }).__dashboardCtx = {
      orgId: 'org-1', projectId: p, currentProjectSlug: 'proj', userName: '김지우',
      orgMemberships: [{ orgId: 'org-1', orgName: 'O', orgSlug: 'o', role: 'owner' }], projectMemberships: [{ projectId: p, projectName: 'Mine', orgId: 'org-1' }],
    };
  }, [PROJ]);
  await page.goto('about:blank');
  await page.goto('http://preview.test/');
  await page.addScriptTag({ content: js });
  await page.evaluate(([l, w]) => (window as unknown as { __mount: (l: string, w: string) => void }).__mount(l!, w!), [o.locale, o.which]);
  if (o.which === 'panel') {
    await page.locator('[data-testid=setup-kind] [role=radio]').nth(1).waitFor({ timeout: 20_000 });
    await page.locator('[data-testid=setup-kind] [role=radio]').nth(1).click();
    await page.getByTestId('setup-move-after').waitFor({ timeout: 20_000 });
  } else if (o.which === 'done') await page.getByTestId('setup-move-old-computer').waitFor({ timeout: 20_000 });
  else await page.getByTestId('desktop-computer-empty').waitFor({ timeout: 20_000 });
  await page.evaluate(() => document.fonts.ready); // the fonts are in before the box is measured and captured
}

const outDir = () => { const d = process.env['CAPTURE_OUT'] || test.info().outputDir; mkdirSync(d, { recursive: true }); return d; };
const tag = (t: 'L' | 'D') => (t === 'L' ? 'light' : 'dark');

/** nothing wider than the screen; no leaf text wider than its own box */
async function fits(page: Page, root: string) {
  const g = await page.evaluate((sel) => {
    const el = document.querySelector(sel) as HTMLElement;
    const over = [...el.querySelectorAll('p, span, a, button, summary, h1, h2, h3, li')].filter((n) => n.children.length === 0 && n.textContent!.trim()
      && (n as HTMLElement).scrollWidth > (n as HTMLElement).clientWidth + 1 && getComputedStyle(n).textOverflow !== 'ellipsis').map((n) => n.textContent!.slice(0, 24));
    const wide = [...el.querySelectorAll('*')].filter((n) => (n as HTMLElement).getBoundingClientRect().right > window.innerWidth + 1).map((n) => `${n.tagName}:${(n.textContent || '').slice(0, 16)}`);
    return { docScroll: document.documentElement.scrollWidth, vw: window.innerWidth, over, wide };
  }, root);
  expect(g.docScroll, 'no horizontal scroll').toBeLessThanOrEqual(g.vw);
  expect(g.wide, 'an element past the right edge').toEqual([]);
  expect(g.over, 'a text wider than its box').toEqual([]);
}

for (const theme of ['L', 'D'] as const) {
  for (const w of [390, 900]) {
    test(`${w} · ${tag(theme)} · the move panel: «옮긴 뒤에 알아 둘 것» under the agents and the folder line`, async ({ page }) => {
      await open(page, { theme, locale: 'ko', w, which: 'panel' });
      const block = page.getByTestId('setup-move-after');
      await expect(block).toContainText('옮긴 뒤에 알아 둘 것');
      await expect(block.locator('li')).toHaveCount(3);
      await expect(block).toContainText('로그인 정보는 옮겨지지 않아요');
      await fits(page, '#root');
      await page.mouse.move(0, 0);
      await page.locator('#root').screenshot({ path: path.join(outDir(), `4986-${w}-${tag(theme)}-1-move-panel.png`) });
    });

    test(`${w} · ${tag(theme)} · the finished move: the old computer let go of the agent, and where to end it`, async ({ page }) => {
      await open(page, { theme, locale: 'ko', w, which: 'done' });
      const line = page.getByTestId('setup-move-old-computer');
      await expect(line).toContainText('다른 컴퓨터에서 일하던 에이전트는 이제 그 컴퓨터에서 지시를 더 받지 않아요');
      await expect(line.getByRole('link', { name: '연결된 기기 보기' })).toBeVisible();
      await fits(page, '#root');
      await page.mouse.move(0, 0);
      await page.locator('#root').screenshot({ path: path.join(outDir(), `4986-${w}-${tag(theme)}-2-done.png`) });
    });

    test(`${w} · ${tag(theme)} · the connected devices: a computer with no agent says it may be disconnected`, async ({ page }) => {
      await open(page, { theme, locale: 'ko', w, which: 'devices' });
      await expect(page.getByTestId('desktop-computer-empty')).toHaveCount(1);
      await expect(page.getByTestId('desktop-computer-empty')).toHaveText('에이전트가 없는 컴퓨터예요 — 끊어도 돼요');
      await fits(page, '[data-testid=desktop-devices]');
      await page.mouse.move(0, 0);
      await page.getByTestId('desktop-devices').screenshot({ path: path.join(outDir(), `4986-${w}-${tag(theme)}-3-empty-computer.png`) });
    });
  }
}

test('390 · en · the three lines read in English', async ({ page }) => {
  await open(page, { theme: 'L', locale: 'en', w: 390, which: 'panel' });
  await expect(page.getByTestId('setup-move-after')).toContainText('After the move');
  await fits(page, '#root');
  await open(page, { theme: 'L', locale: 'en', w: 390, which: 'done' });
  await expect(page.getByTestId('setup-move-old-computer')).toContainText('no longer takes instructions there');
  await fits(page, '#root');
  await open(page, { theme: 'L', locale: 'en', w: 390, which: 'devices' });
  await expect(page.getByTestId('desktop-computer-empty')).toContainText('A computer with no agents');
  await fits(page, '[data-testid=desktop-devices]');
});
