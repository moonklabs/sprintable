/**
 * story #4580 AC2 — the web's scenes of Yuna's capture list (`4580/ac2-captures.md` ① · ② · ④-1 · ④-2): the agent's «허용 주소» row
 * in its «실행» group and the network question's two states on the inbox card (the phone's web view). Real components (bundled
 * here with esbuild — not copied) and the real Tailwind build of globals.css, in Chromium, light and dark, at the widths the list
 * names. No server of ours: the page and its API answers are made here; only five modules are stubbed (the fetch client, the SSE
 * hook, the flat-link hook, the phone bridge and the phone's signed answer — the OS prompt is the phone's, a real-device capture).
 *
 * Rules (the list's): the target is on screen · two animation frames after the change · the shot is the row or card itself ·
 * names `4580-ac2-{n}-{scene}-{L|D}-{width}.png`. Files go to CAPTURE_OUT when set, else this test's output folder.
 */
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { compile, optimize } from '@tailwindcss/node';
import { layoutStubPlugin } from './support/layout-stubs';

const req = createRequire(__filename);
const WEB = path.join(__dirname, '..');
const APP = path.join(WEB, 'src', 'app');
const LONG = 'very-long-subdomain-name-for-testing.build-cache.example-corp.internal';


let built: { js: string; css: string } | null = null;
async function build() {
  if (built) return built;
  const esbuild = req('esbuild') as typeof import('esbuild');
  const out = await esbuild.build({
    stdin: {
      contents: `
        import React from 'react'; import { createRoot } from 'react-dom/client'; import { NextIntlClientProvider } from 'next-intl';
        import ko from './messages/ko.json'; import en from './messages/en.json';
        import { AgentRunProfileSection } from './src/components/agents/agent-run-profile-section';
        import { AgentPermissionRequests } from './src/components/inbox/agent-permission-requests';
        window.__mount = (kind, locale) => createRoot(document.getElementById('root')).render(
          React.createElement(NextIntlClientProvider, { locale, messages: locale === 'en' ? en : ko, timeZone: 'Asia/Seoul' },
            kind === 'profile' ? React.createElement(AgentRunProfileSection, { agentId: 'a1', runtimeType: 'claude-code' })
              : React.createElement(AgentPermissionRequests)));`,
      resolveDir: WEB, loader: 'tsx',
    },
    bundle: true, format: 'iife', platform: 'browser', write: false, logLevel: 'silent', jsx: 'automatic',
    tsconfig: path.join(WEB, 'tsconfig.json'), define: { 'process.env.NODE_ENV': '"production"' },
    plugins: [layoutStubPlugin()],
  });
  const js = out.outputFiles[0]!.text;
  // every class the bundle can render — the strings in it, split (unknown tokens are ignored by the compiler)
  // no length cap: a base class string (Button's is 615 long) cut off here drew the wrong border and focus ring (Yuna 4972 ②)
  const candidates = [...new Set([...js.matchAll(/"([^"\n]+)"/g)].flatMap((m) => m[1]!.split(/\s+/)).filter(Boolean))];
  const compiler = await compile(readFileSync(path.join(APP, 'globals.css'), 'utf8'), { base: APP, onDependency: () => {} });
  const css = (optimize as unknown as (c: string, o?: object) => { code: string })(compiler.build(candidates), { minify: false }).code;
  built = { js, css };
  return built;
}

type Answers = Record<string, unknown>;
async function open(page: Page, o: { kind: 'profile' | 'inbox'; width: number; theme: 'L' | 'D'; api: Answers; phone?: boolean }) {
  const { js, css } = await build();
  await page.setViewportSize({ width: o.width, height: o.width < 500 ? 844 : 900 });
  await page.route('http://preview.test/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/') {
      return route.fulfill({ contentType: 'text/html', body: `<!doctype html><html lang="ko" class="${o.theme === 'D' ? 'dark' : ''}"><head><meta charset="utf-8"><style>${css}</style></head><body class="bg-background text-foreground"><div id="root" style="padding:16px;max-width:${o.kind === 'profile' ? 760 : 520}px"></div></body></html>` });
    }
    const key = `${route.request().method()} ${url.pathname}`;
    const body = o.api[key] ?? o.api[url.pathname];
    return body === undefined ? route.fulfill({ status: 404, body: '{}' }) : route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
  });
  await page.goto('http://preview.test/');
  if (o.phone) await page.evaluate(() => { (window as unknown as { __phone: boolean }).__phone = true; });
  // a module the stubs miss can throw while the bundle loads — then `__mount` is never set. Say what threw, by name, instead of
  // «__mount is not a function» (story #4583: the inbox gained remote-off.tsx's imports and this harness only said that)
  const thrown: string[] = [];
  page.on('pageerror', (e) => thrown.push(e.message));
  await page.addScriptTag({ content: js });
  if (!(await page.evaluate(() => typeof (window as unknown as { __mount?: unknown }).__mount === 'function'))) {
    throw new Error(`the bundle did not start — likely a module to stub (STUBS): ${thrown.join(' | ') || 'no page error'}`);
  }
  await page.evaluate((k) => (window as unknown as { __mount: (k: string, l: string) => void }).__mount(k, 'ko'), o.kind);
}

const frames = (page: Page) => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(1)))));
async function shot(page: Page, target: Locator, name: string) {
  await target.scrollIntoViewIfNeeded();
  await page.mouse.move(0, 0); // no hover paint from the last click (Yuna 4972 ②)
  await frames(page);
  const dir = process.env['CAPTURE_OUT'] || test.info().outputDir;
  mkdirSync(dir, { recursive: true });
  await target.screenshot({ path: path.join(dir, `${name}.png`) });
}

// ── ① the «허용 주소» row (web settings · 1440 · 390) ──────────────────────────────────────────────────────────────────────
const OPTIONS = { runtimes: [{ runtime: 'claude-code', models: [{ name: 'opus', efforts: ['low', 'medium', 'high'] }], custom_model_efforts: ['low', 'medium', 'high'] }], model_pattern: '^[a-z0-9.-]+$' };
const profile = (hosts: string[], canChange = true) => ({
  '/api/agent-run-profile/options': { data: OPTIONS },
  'GET /api/agents/a1/run-profile': { data: { agent_id: 'a1', runtime: 'claude-code', model: 'opus', effort: 'high', version: 3, updated_at: '2026-10-07T01:00:00Z', can_change: canChange, allowed_hosts: hosts.map((host) => ({ host, added_at: '2026-10-07T01:00:00Z' })) } },
});

for (const width of [1440, 390]) for (const theme of ['L', 'D'] as const) {
  test(`[4580 AC2 ①] «허용 주소» rows · ${theme} · ${width}`, async ({ page }) => {
    const row = page.getByTestId('run-profile-allowed-hosts');
    const section = row.locator('xpath=ancestor::*[contains(@class,"rounded")][1]');
    await open(page, { kind: 'profile', width, theme, api: profile([]) });
    await expect(row).toContainText('허용한 주소가 없어요');
    await expect(row.getByRole('button')).toHaveCount(0);
    await expect(row).not.toContainText('빼면 바로 적용돼요'); // nothing to remove: no «applies right away» line
    await shot(page, row, `4580-ac2-1-1-empty-${theme}-${width}`);

    await open(page, { kind: 'profile', width, theme, api: { ...profile(['gitlab.com']), 'DELETE /api/agents/a1/run-profile/allowed-hosts/gitlab.com': { data: { host: 'gitlab.com', removed: true } } } });
    await expect(row).toContainText('gitlab.com');
    await expect(row).toContainText('이 에이전트가 묻지 않고 연결할 수 있는 주소예요');
    await expect(row).toContainText('빼면 바로 적용돼요 — 그 주소는 다음 연결부터 다시 물어요');
    await shot(page, row, `4580-ac2-1-2-one-${theme}-${width}`);
    await shot(page, section, `4580-ac2-1-6-group-head-${theme}-${width}`); // the group's head line and the row's own line, both
    await row.getByRole('button', { name: /빼기/ }).click();
    await expect(page.getByRole('status')).toHaveText('뺐어요 · gitlab.com');
    await expect(row).toContainText('허용한 주소가 없어요');
    await shot(page, section, `4580-ac2-1-5-removed-${theme}-${width}`);

    await open(page, { kind: 'profile', width, theme, api: profile(['api.github.com', 'gitlab.com', 'pypi.org']) });
    await expect(row.getByRole('button', { name: /빼기/ })).toHaveCount(3);
    await shot(page, row, `4580-ac2-1-3-many-${theme}-${width}`);

    await open(page, { kind: 'profile', width, theme, api: profile(['gitlab.com', 'pypi.org'], false) });
    await expect(row).toContainText('pypi.org');
    await expect(row.getByRole('button')).toHaveCount(0); // not even a disabled one
    await expect(row).not.toContainText('빼면 바로 적용돼요'); // they cannot remove: no line about removing
    await shot(page, row, `4580-ac2-1-4-no-remove-${theme}-${width}`);

    await open(page, { kind: 'profile', width, theme, api: profile([LONG, 'pypi.org']) });
    const remove = row.getByRole('button', { name: new RegExp(LONG.replace(/\./g, '\\.')) });
    await expect(remove).toBeVisible();
    const fits = await row.evaluate((el) => el.scrollWidth <= el.clientWidth + 1);
    expect(fits, 'a long host wraps inside the row — [빼기] is not pushed out').toBe(true);
    await shot(page, row, `4580-ac2-4-2-long-host-${theme}-${width}`);
  });
}

// ── ② the inbox card in the phone's web view (390) · ④-1 a long host ─────────────────────────────────────────────────────
const NOW = Date.now();
const req0 = (o: Answers = {}) => ({
  id: 'p1', request_id: 'r1', setup_id: 's1', device_name: 'SYJ-MacBook-Pro', agent_member_id: 'a1', agent_name: 'Dev', role: 'Developer',
  tool: 'SandboxNetwork', runtime: 'claude', tool_name: { ko: '네⁠트⁠워⁠크 연⁠결', en: 'Network connection' }, summary: 'network',
  masked: false, truncated: false, workdir: null, created_at: new Date(NOW - 120_000).toISOString(), expires_at: new Date(NOW + 600_000).toISOString(),
  state: 'pending', answered_by_name: null, decision: null, device_reachable: true, recipient_reason: 'paired', answerable: true,
  session_key: 's-1', input_hash: 'sha256:' + 'b'.repeat(64), stage: 'ask', host: null, ...o,
});
const inbox = (r: Answers) => ({ '/api/agent-permission-requests': { requests: [r] } });

for (const theme of ['L', 'D'] as const) {
  test(`[4580 AC2 ②] the network question's card · ${theme} · 390`, async ({ page }) => {
    const card = page.getByTestId('agent-permission-card');
    await open(page, { kind: 'inbox', width: 390, theme, api: inbox(req0()), phone: true });
    await expect(card).toContainText('어디에 연결하려는지는 [허용…]을 누르면 보여요 — 보고 나서 정해요');
    expect(await card.textContent()).not.toContain('gitlab');
    await expect(card.getByRole('button', { name: '허용…' })).toBeVisible();
    await card.getByRole('button', { name: '거부' }).focus(); // the focus ring on [거부] (B-2 · 배치 ①)
    await shot(page, card, `4580-ac2-2-1-first-${theme}-390`);
    await card.getByRole('button', { name: '허용…' }).click();
    await expect(card).toContainText('주소를 확인하는 중…');
    await shot(page, card, `4580-ac2-2-2-checking-${theme}-390`);

    await open(page, { kind: 'inbox', width: 390, theme, api: inbox(req0()), phone: true });
    await card.getByRole('button', { name: '거부' }).click();
    await expect(card).toContainText('거부됨 · 네');
    await shot(page, card, `4580-ac2-2-8-denied-${theme}-390`);

    const second = inbox(req0({ stage: 'confirm', host: 'gitlab.com' }));
    await open(page, { kind: 'inbox', width: 390, theme, api: second, phone: true });
    await expect(card).toContainText('gitlab.com 연결을 허용하고 이어 갈까요');
    await expect(card).toContainText('에이전트가 이 주소에 연결하려다 멈췄어요.');
    await expect(card).toContainText('이 에이전트에만 · 이 주소만 허용돼요 — 에이전트 설정에서 뺄 수 있어요');
    await expect(card.getByRole('button', { name: '허용하지 않기' })).toBeFocused(); // first focus (배치 ②)
    await expect(page.getByTestId('agent-permission-card')).toHaveCount(1); // the same card, not a new one
    await shot(page, card, `4580-ac2-2-3-confirm-${theme}-390`);
    await card.getByRole('button', { name: '허용하고 이어 가기' }).click();
    await expect(card).toContainText('허용됐어요 · gitlab.com — 에이전트에게 다시 해 보라고 넘겼어요');
    await shot(page, card, `4580-ac2-2-5-allowed-${theme}-390`);

    await open(page, { kind: 'inbox', width: 390, theme, api: second, phone: true });
    await card.getByRole('button', { name: '허용하지 않기' }).click();
    await expect(card).toContainText('허용하지 않았어요');
    await shot(page, card, `4580-ac2-2-6-not-allowed-${theme}-390`);

    // 2-7 (F2): the host could not be read — the request ended with nothing allowed
    await open(page, { kind: 'inbox', width: 390, theme, api: inbox(req0({ state: 'withdrawn', host_unread: true, answerable: false })), phone: true });
    await expect(card).toContainText('주소를 확인하지 못해 이번 연결은 허용하지 못했어요');
    await expect(card.getByRole('button')).toHaveCount(0);
    await shot(page, card, `4580-ac2-2-7-host-unread-${theme}-390`);

    await open(page, { kind: 'inbox', width: 390, theme, api: inbox(req0({ stage: 'confirm', host: LONG })), phone: true });
    await expect(card).toContainText(LONG);
    expect(await card.evaluate((el) => el.scrollWidth <= el.clientWidth + 1), 'a long host wraps inside the card').toBe(true);
    await shot(page, card, `4580-ac2-4-1-long-host-${theme}-390`);
  });
}
