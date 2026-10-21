/**
 * story 4734 — the web screens of «the computer is the pairing unit» at 390 px, light and dark: the real `DesktopDevices` and `DesktopRemoteDevices` (bundled with esbuild, not copied)
 * and the real Tailwind build of globals.css; only the API answers are made up (a Mac with three setups, another Mac with one, a phone paired with both). Scenes: the list folded ·
 * the first computer's fold open · the «이 컴퓨터 모두 끊기» confirm · one setup's own confirm (with the «이 설정만» sentence) · a phone's pairs collapsed by computer. Asserted: nothing is wider
 * than the screen, no text is cut off in its box, the buttons' texts stay on one line or wrap whole. With CAPTURE_OUT set, the captures are written there (Yuna's design look).
 */
import { mkdirSync, readFileSync } from 'node:fs';
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
    // the browser, not the phone app: no bridge (the phone state is «not the phone app», nothing to claim or call)
    // `window.__phoneMode` set before mounting = the phone app (a signing bridge that knows this phone's check number); unset = a browser
    '@/lib/phone-bridge': 'export const claimPhoneBridge = () => {}; export const isPhoneApp = () => !!window.__phoneMode; export const subscribePhoneApp = () => () => {}; export const phoneCall = async (k) => (k === "device.key.info" ? { id: "x", ok: true, key_number: "482 917" } : { id: "x", ok: false });',
    // the page's role: an admin of the organization (the list is read) — the shared stub gives only an org id
    '@/app/dashboard/dashboard-shell': "export function useDashboardContext() { return { orgId: 'org-1', orgMemberships: [{ orgId: 'org-1', orgName: 'Moonk', orgSlug: 'moonk', role: 'admin' }], projectMemberships: [], userName: '김지우' }; }",
  };
  const filter = new RegExp(`^(${Object.keys(bodies).map((k) => k.replace(/[/.-]/g, '\\$&')).join('|')})$`);
  const out = await esbuild.build({
    stdin: {
      contents: `
        import React from 'react'; import { createRoot } from 'react-dom/client'; import { NextIntlClientProvider } from 'next-intl';
        import ko from './messages/ko.json'; import en from './messages/en.json';
        import { DesktopDevices } from './src/components/desktop/desktop-devices';
        import { DesktopRemoteDevices } from './src/components/desktop/desktop-remote-devices';
        import { PhoneBridgeClaim } from './src/components/providers/phone-bridge-claim';
        import { PhoneFirstScreen } from './src/components/desktop/phone-first-screen';
        window.__mount = (locale, which) => {
          if (which === 'start') window.__phoneMode = true;
          const body = which === 'phones' ? React.createElement(PhoneBridgeClaim, null, React.createElement(DesktopRemoteDevices))
            : which === 'start' ? React.createElement(PhoneBridgeClaim, null, React.createElement(PhoneFirstScreen, { orgId: 'org-1', chatsHref: '/chats' }))
            : React.createElement(DesktopDevices);
          createRoot(document.getElementById('root')).render(React.createElement(NextIntlClientProvider, { locale, messages: locale === 'en' ? en : ko, timeZone: 'Asia/Seoul' },
            React.createElement('div', { className: 'mx-auto w-full max-w-md px-4 pt-4' }, body)));
        };`,
      resolveDir: WEB, loader: 'tsx',
    },
    bundle: true, format: 'iife', platform: 'browser', write: false, logLevel: 'silent', jsx: 'automatic',
    tsconfig: path.join(WEB, 'tsconfig.json'),
    define: { 'process.env.NODE_ENV': '"production"', 'process.env.NEXT_PUBLIC_APP_URL': '"https://app.sprintable.ai"' },
    plugins: [
      { name: 'computers-4734-stubs', setup(b) { b.onResolve({ filter }, (a) => ({ path: a.path, namespace: 'stub4734' })); b.onLoad({ filter: /.*/, namespace: 'stub4734' }, (a) => ({ contents: bodies[a.path]!, loader: 'js', resolveDir: WEB })); } },
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

const sid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const setup = (n: number, name: string, day: number, over: Record<string, unknown> = {}) => ({
  setup_id: sid(n), device_name: name, state: 'handed_over', confirmed_at: `2026-10-${String(day).padStart(2, '0')}T01:00:00Z`, confirmed_by_name: '김지우', revoked_at: null, revoked_by_name: null,
  active_keys: 1, paired_phones: 1,
  members: [{ kind: 'agent', member_id: `a${n}`, name: ['결제 담당', '문서 정리', '리뷰 도우미', '사무실 점검'][n % 4], role: 'Dev' }], ...over,
});
const MAC_A = 'SYJ-MacBook-Pro';
const COMPUTERS = {
  truncated: false,
  computers: [
    { computer_id: 'c1111111-1111-4111-8111-111111111111', device_name: MAC_A, state: 'handed_over', confirmed_by_name: '김지우', confirmed_at: '2026-10-12T01:00:00Z', last_used_at: null, live_setups: 3, active_keys: 3,
      setups: [setup(1, MAC_A, 12), setup(2, MAC_A, 15, { paired_phones: 2 }), setup(3, MAC_A, 19, { members: ['결제 담당', '문서 정리', '리뷰 도우미', '사무실 점검'].map((name, i) => ({ kind: 'agent', member_id: `a3-${i}`, name, role: 'Dev' })) })] },
    { computer_id: 'c2222222-2222-4222-8222-222222222222', device_name: '사무실 맥 스튜디오 · 3층 회의실 옆', state: 'handed_over', confirmed_by_name: '김지우', confirmed_at: '2026-10-18T01:00:00Z', last_used_at: null, live_setups: 1, active_keys: 1,
      setups: [setup(4, '사무실 맥 스튜디오 · 3층 회의실 옆', 18)] },
  ],
};
const PHONES = { devices: [{ id: 'p1', label: '윤재의 아이폰', confirm_number: '482 917', last_used_at: null,
  pairs: [
    { setup_id: sid(1), computer_id: COMPUTERS.computers[0]!.computer_id, device_name: MAC_A, paired_at: '2026-10-12T03:00:00Z' },
    { setup_id: sid(2), computer_id: COMPUTERS.computers[0]!.computer_id, device_name: MAC_A, paired_at: '2026-10-15T03:00:00Z' },
    { setup_id: sid(3), computer_id: COMPUTERS.computers[0]!.computer_id, device_name: MAC_A, paired_at: '2026-10-19T03:00:00Z' },
    { setup_id: sid(4), computer_id: COMPUTERS.computers[1]!.computer_id, device_name: '사무실 맥 스튜디오 · 3층 회의실 옆', paired_at: '2026-10-18T03:00:00Z' },
  ] }] };

// /startable: one entry per SETUP on the wire (the phone shell finds an entry by setup_id); two setups of one Mac share a computer_id, so the screen draws ONE card with both setups' agents
const startAgent = (id: string, name: string, project: string) => ({ agent_member_id: id, name, can_command: true, projects: [{ project_id: `p-${id}`, name: project }], running: null });
const STARTABLE = { remote_control: true, computers: [
  { setup_id: sid(1), computer_id: COMPUTERS.computers[0]!.computer_id, device_name: MAC_A, reachable: true, agents: [startAgent('a1', '결제 담당', '결제 개편')] },
  { setup_id: sid(2), computer_id: COMPUTERS.computers[0]!.computer_id, device_name: MAC_A, reachable: true, agents: [startAgent('a2', '문서 정리', '정산 문서')] },
] };

async function open(page: Page, o: { theme: 'L' | 'D'; locale: 'ko' | 'en'; which: 'devices' | 'phones' | 'start' }) {
  const { js, css } = await build();
  await page.setViewportSize({ width: 390, height: 900 });
  await page.unrouteAll();
  await page.route('http://preview.test/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/') {
      return route.fulfill({ contentType: 'text/html', body: `<!doctype html><html lang="${o.locale}" class="${o.theme === 'D' ? 'dark' : ''}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head><body class="bg-background text-foreground"><div id="root"></div></body></html>` });
    }
    const json = (b: unknown) => route.fulfill({ contentType: 'application/json', body: JSON.stringify(b) });
    if (url.pathname === '/api/desktop/computers') return json(COMPUTERS);
    if (url.pathname === '/api/remote-devices') return json(PHONES);
    if (url.pathname === '/api/desktop/startable') return json(STARTABLE);
    if (url.pathname === '/api/organizations/org-1/remote-control') return json({ data: { enabled: true, enabled_at: null, can_change: true } });
    return route.fulfill({ status: 404, body: '{}' });
  });
  await page.goto('about:blank');
  await page.goto('http://preview.test/');
  await page.addScriptTag({ content: js });
  if (o.which === 'start') await page.evaluate(() => { (window as unknown as { __phoneMode: boolean }).__phoneMode = true; });
  await page.evaluate(([l, w]) => (window as unknown as { __mount: (l: string, w: string) => void }).__mount(l!, w!), [o.locale, o.which]);
  await page.getByTestId(o.which === 'devices' ? 'desktop-computer-row' : o.which === 'phones' ? 'desktop-remote-phone' : 'onboarding-phone-start').first().waitFor();
}

const outDir = () => { const d = process.env['CAPTURE_OUT'] || test.info().outputDir; mkdirSync(d, { recursive: true }); return d; };
const tag = (t: 'L' | 'D') => (t === 'L' ? 'light' : 'dark');

/** nothing wider than the screen; no leaf text wider than its own box (a long name must wrap or cut with an ellipsis the page chose, never run out of the card) */
async function fits(page: Page, root: string) {
  const g = await page.evaluate((sel) => {
    const el = document.querySelector(sel) as HTMLElement;
    const over = [...el.querySelectorAll('p, span, a, button, summary, h1, h2, h3')].filter((n) => n.children.length === 0 && n.textContent!.trim()
      && (n as HTMLElement).scrollWidth > (n as HTMLElement).clientWidth + 1 && getComputedStyle(n).textOverflow !== 'ellipsis').map((n) => n.textContent!.slice(0, 24));
    const wide = [...el.querySelectorAll('*')].filter((n) => (n as HTMLElement).getBoundingClientRect().right > window.innerWidth + 1).map((n) => `${n.tagName}:${(n.textContent || '').slice(0, 16)}`);
    return { docScroll: document.documentElement.scrollWidth, vw: window.innerWidth, over, wide };
  }, root);
  expect(g.docScroll, 'no horizontal scroll').toBeLessThanOrEqual(g.vw);
  expect(g.wide, 'an element past the right edge').toEqual([]);
  expect(g.over, 'a text wider than its box').toEqual([]);
}

for (const theme of ['L', 'D'] as const) {
  test(`390 · ${tag(theme)} · devices: one line per computer (folded), then the first computer's fold open`, async ({ page }) => {
    await open(page, { theme, locale: 'ko', which: 'devices' });
    await expect(page.getByTestId('desktop-computer-row')).toHaveCount(2);
    await expect(page.getByTestId('desktop-computer-meta').first()).toContainText('에이전트 6개 · 설정 3곳');
    await fits(page, '[data-testid=desktop-devices]');
    await page.mouse.move(0, 0);
    await page.getByTestId('desktop-devices').screenshot({ path: path.join(outDir(), `4734-390-${tag(theme)}-1-folded.png`) });
    await page.getByTestId('desktop-computer-row').first().locator('summary').first().click();
    await expect(page.getByTestId('desktop-device-row').first()).toBeVisible();
    // story 4734 §A-2b: a setup row says WHICH setup it is by its agents' names — one name, and the third row's four names as «앞 둘 외 2»
    await expect(page.getByTestId('desktop-device-names').first()).toContainText('문서 정리');
    await expect(page.getByTestId('desktop-device-names').nth(2)).toContainText('결제 담당 · 문서 정리 외 2');
    await fits(page, '[data-testid=desktop-devices]');
    await page.mouse.move(0, 0);
    await page.getByTestId('desktop-devices').screenshot({ path: path.join(outDir(), `4734-390-${tag(theme)}-2-open.png`) });
  });

  test(`390 · ${tag(theme)} · «이 컴퓨터 모두 끊기» confirm: the irreversible line first, the number in the button, buttons reachable`, async ({ page }) => {
    await open(page, { theme, locale: 'ko', which: 'devices' });
    await page.getByTestId('desktop-computer-disconnect-all').first().click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toContainText('되돌릴 수 없어요.');
    await expect(page.getByTestId('desktop-computers-confirm-all')).toHaveText('설정 3곳 모두 끊기');
    await expect(dialog).toHaveCSS('opacity', '1'); // the open animation is done before it is measured and captured
    const g = await page.evaluate(() => {
      const d = document.querySelector('[role=dialog]') as HTMLElement;
      const b = d.getBoundingClientRect();
      const btn = (document.querySelector('[data-testid=desktop-computers-confirm-all]') as HTMLElement).getBoundingClientRect();
      return { l: b.left, r: b.right, t: b.top, bottom: b.bottom, vw: window.innerWidth, vh: window.innerHeight, btnB: btn.bottom, btnR: btn.right };
    });
    expect(g.l).toBeGreaterThanOrEqual(0);
    expect(g.r).toBeLessThanOrEqual(g.vw);
    expect(g.btnR, 'the confirm button is inside the screen').toBeLessThanOrEqual(g.vw);
    expect(g.btnB, 'the confirm button is not below the screen').toBeLessThanOrEqual(g.vh);
    await fits(page, '[role=dialog]');
    await page.mouse.move(0, 0);
    await page.screenshot({ path: path.join(outDir(), `4734-390-${tag(theme)}-3-confirm-all.png`) });
  });

  test(`390 · ${tag(theme)} · one setup's own confirm adds «이 설정만 끊어요» (the computer has other connected setups)`, async ({ page }) => {
    await open(page, { theme, locale: 'ko', which: 'devices' });
    await page.getByTestId('desktop-computer-row').first().locator('summary').first().click();
    await page.getByTestId('desktop-device-disconnect').first().click();
    await expect(page.getByTestId('desktop-devices-only-this')).toContainText('이 설정만 끊어요 — 이 컴퓨터의 다른 설정 2곳은 그대로예요.');
    await expect(page.getByTestId('desktop-devices-confirm-agents')).toContainText('이 설정의 에이전트: 문서 정리');
    await expect(page.getByRole('dialog')).toHaveCSS('opacity', '1');
    await fits(page, '[role=dialog]');
    await page.mouse.move(0, 0);
    await page.screenshot({ path: path.join(outDir(), `4734-390-${tag(theme)}-4-confirm-one.png`) });
  });

  test(`390 · ${tag(theme)} · a phone's pairs: one line per computer (4 pairs → 2 lines), the name once`, async ({ page }) => {
    await open(page, { theme, locale: 'ko', which: 'phones' });
    await expect(page.getByTestId('desktop-remote-device-row')).toHaveCount(2);
    await fits(page, '[data-testid=desktop-remote-devices]');
    await page.mouse.move(0, 0);
    await page.getByTestId('desktop-remote-devices').screenshot({ path: path.join(outDir(), `4734-390-${tag(theme)}-5-phone-pairs.png`) });
  });
}

test('390 · en · the folded list and the confirm read in English with plurals', async ({ page }) => {
  await open(page, { theme: 'L', locale: 'en', which: 'devices' });
  await expect(page.getByTestId('desktop-computer-meta').first()).toContainText('6 agents · 3 setups');
  await expect(page.getByTestId('desktop-computer-meta').nth(1)).toContainText('1 agent · 1 setup');
  await page.getByTestId('desktop-computer-disconnect-all').first().click();
  await expect(page.getByTestId('desktop-computers-confirm-all')).toHaveText('Disconnect all 3 setups');
  await fits(page, '[role=dialog]');
});

for (const theme of ['L', 'D'] as const) {
  test(`390 · ${tag(theme)} · the phone's first screen: ONE card for a Mac with two setups, both setups' agents in the agent sheet`, async ({ page }) => {
    await open(page, { theme, locale: 'ko', which: 'start' });
    await expect(page.getByTestId('onboarding-phone-computer')).toHaveCount(0); // one computer: no computer picker (reverted: a card per setup → a picker of two «SYJ-MacBook-Pro»)
    await expect(page.getByRole('heading')).toContainText('SYJ-MacBook-Pro');
    await fits(page, '[data-testid=onboarding-phone-start]');
    await page.mouse.move(0, 0);
    await page.screenshot({ path: path.join(outDir(), `4734-390-${tag(theme)}-6-phone-start.png`) });
    await page.getByTestId('onboarding-phone-agent').click();
    const rows = page.getByTestId('onboarding-phone-sheet-row');
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(0)).toContainText('결제 담당');
    await expect(rows.nth(1)).toContainText('문서 정리');
    await page.mouse.move(0, 0);
    await page.screenshot({ path: path.join(outDir(), `4734-390-${tag(theme)}-7-phone-agent-sheet.png`) });
  });
}
