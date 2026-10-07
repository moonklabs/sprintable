/**
 * story #4583 — Yuna's capture list (`4583/web-captures.md`): «원격 제어» off in each web place, owner and not owner, light and dark,
 * 1440 and 390. Real components (bundled here with esbuild — not copied) and the real Tailwind build of globals.css, in Chromium.
 * No server of ours: the page and its API answers are made here; seven modules are stubbed (the fetch client, the SSE hook, the
 * flat-link hook, the phone bridge, the phone's signed answer, the dashboard context and the viewer's time zone) and next/link is a
 * plain anchor. The harness is PR 4972's (Didi · `allowed-hosts.4580.layout.spec.ts`).
 *
 * Each scene is also an assertion: the copy (Yuna `4583/copy.md` — this file holds it on purpose: a drift there is a failure here) ·
 * a «no line» scene has no element in the DOM (not hidden) · the link sits on its own row under the line · every new line's contrast
 * on its own background is ≥ 4.5, measured on the shot's pixels · arriving at `/desktop#remote-control`, the owner's switch holds the
 * focus with a ring that shows in pixels, and the switch stays off.
 *
 * Rules (the list's): the target is on screen · two animation frames after the change (and, for a pixel comparison, the element's
 * transitions finished — story #4600) · `mouse.move(0, 0)` before each shot · no cap
 * on the class candidates · names `4583-web-{#}-{scene}-{owner|member}-{L|D}-{width}.png`. Files go to CAPTURE_OUT when set, else
 * this test's output folder (with `contrast.json`).
 */
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { compile, optimize } from '@tailwindcss/node';

const req = createRequire(__filename);
const WEB = path.join(__dirname, '..');
const APP = path.join(WEB, 'src', 'app');

const STUBS: Record<string, string> = {
  '@/lib/db/client': 'export const fetchWithAuth = (u, i) => fetch(u, i);',
  '@/hooks/use-sse-notifications': 'export function useSseNotifications() {}',
  '@/hooks/use-flat-href': 'export function useFlatHref() { return (h) => h; }',
  '@/lib/phone-bridge': `export const isPhoneApp = () => !!window.__phone;
    export const phoneCall = async (k) => {
      if (k === 'pair.scan') return { ok: true, offer_id: '0f3c2a1e-1111-4222-8333-944455556666', setup_id: '12345678-9abc-4def-8123-456789abcdef', device_name: 'SYJ-MacBook-Pro', expires_at: new Date(Date.now() + 300000).toISOString() };
      if (k === 'device.key.info') return { ok: true, public_key: 'pk' };
      if (k === 'pair.mac') return { ok: true, mac: 'mac' };
      if (k === 'device.auth') return { id: 'x', ok: true, auth: 'biometric' };
      return { id: 'x', ok: false };
    };`,
  '@/lib/phone-answer': 'export async function answerOnPhone(id, decision) { return { kind: "answered", decision }; }',
  '@/app/dashboard/dashboard-shell': "export function useDashboardContext() { return { orgId: 'org-1' }; }",
  '@/components/viewer-time-zone': "export function useViewerTimeZone() { return 'Asia/Seoul'; }",
  // a client navigation like Next's: the link's own onClick first, then (unless prevented) no page load — the harness swaps the view
  'next/link': "import React from 'react'; export default function Link({ href, children, onClick, ...rest }) { return React.createElement('a', { href, ...rest, onClick: (e) => { onClick && onClick(e); if (!e.defaultPrevented && window.__clientNav) { e.preventDefault(); window.__clientNav(href); } } }, children); }",
};
const STUB_FILTER = /^(@\/lib\/db\/client|@\/hooks\/use-sse-notifications|@\/hooks\/use-flat-href|@\/lib\/phone-bridge|@\/lib\/phone-answer|@\/app\/dashboard\/dashboard-shell|@\/components\/viewer-time-zone|next\/link)$/;

let built: { js: string; css: string } | null = null;
async function build() {
  if (built) return built;
  const esbuild = req('esbuild') as typeof import('esbuild');
  const out = await esbuild.build({
    stdin: {
      contents: `
        import React from 'react'; import { createRoot } from 'react-dom/client'; import { NextIntlClientProvider } from 'next-intl';
        import ko from './messages/ko.json'; import en from './messages/en.json';
        import { PhonePairing } from './src/components/desktop/phone-pairing';
        import { DesktopRemoteConfirm } from './src/components/desktop/desktop-remote-confirm';
        import { AgentSessionStrip } from './src/components/chat/agent-session-strip';
        import { AgentPermissionRequests } from './src/components/inbox/agent-permission-requests';
        import { DesktopRemoteControlCard } from './src/components/desktop/desktop-remote-control-card';
        const h = React.createElement;
        const pick = (kind) => kind === 'pair' ? h(PhonePairing) : kind === 'remote' ? h(DesktopRemoteConfirm)
          : kind === 'strip' ? h(AgentSessionStrip, { agentId: 'a1', conversationId: 'c1' }) : kind === 'inbox' ? h(AgentPermissionRequests)
          : kind === 'card-far' ? h(React.Fragment, null, h('div', { style: { height: 1600 } }), h(DesktopRemoteControlCard)) : h(DesktopRemoteControlCard);
        window.__mount = (kind, locale) => {
          const root = createRoot(document.getElementById('root'));
          const wrap = (k) => h(NextIntlClientProvider, { locale, messages: locale === 'en' ? en : ko, timeZone: 'Asia/Seoul' }, pick(k));
          // story #4583 (Yuna 4974): the link → card path as an in-app navigation (no reload) — pushState, then the card
          window.__clientNav = (href) => { history.pushState(null, '', href); root.render(wrap('card-far')); };
          root.render(wrap(kind));
        };`,
      resolveDir: WEB, loader: 'tsx',
    },
    bundle: true, format: 'iife', platform: 'browser', write: false, logLevel: 'silent', jsx: 'automatic',
    tsconfig: path.join(WEB, 'tsconfig.json'), define: { 'process.env.NODE_ENV': '"production"' },
    plugins: [{ name: 'stubs', setup(b) {
      b.onResolve({ filter: STUB_FILTER }, (a) => ({ path: a.path, namespace: 'stub' }));
      b.onLoad({ filter: /.*/, namespace: 'stub' }, (a) => ({ contents: STUBS[a.path]!, loader: 'js', resolveDir: WEB }));
    } }],
  });
  const js = out.outputFiles[0]!.text;
  // every class the bundle can render — no length cap (PR 4972: a cut Button base string drew the wrong border and ring)
  const candidates = [...new Set([...js.matchAll(/"([^"\n]+)"/g)].flatMap((m) => m[1]!.split(/\s+/)).filter(Boolean))];
  const compiler = await compile(readFileSync(path.join(APP, 'globals.css'), 'utf8'), { base: APP, onDependency: () => {} });
  const css = (optimize as unknown as (c: string, o?: object) => { code: string })(compiler.build(candidates), { minify: false }).code;
  built = { js, css };
  return built;
}

type Kind = 'pair' | 'remote' | 'strip' | 'inbox' | 'card' | 'card-far';
type Answer = unknown | { __status: number; body: unknown };
const WIDTH: Record<Kind, number> = { pair: 420, remote: 640, strip: 760, inbox: 560, card: 760, 'card-far': 760 };

async function open(page: Page, o: { kind: Kind; width: number; theme: 'L' | 'D'; api: Record<string, Answer>; phone?: boolean; hash?: string; locale?: 'ko' | 'en' }) {
  const { js, css } = await build();
  await page.setViewportSize({ width: o.width, height: o.width < 500 ? 844 : 900 });
  await page.unrouteAll();
  await page.route('http://preview.test/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/') {
      return route.fulfill({ contentType: 'text/html', body: `<!doctype html><html lang="${o.locale ?? 'ko'}" class="${o.theme === 'D' ? 'dark' : ''}"><head><meta charset="utf-8"><style>${css}</style></head><body class="bg-background text-foreground"><div id="root" style="padding:16px;max-width:${WIDTH[o.kind]}px"></div></body></html>` });
    }
    const a = o.api[`${route.request().method()} ${url.pathname}`] ?? o.api[url.pathname];
    if (a === undefined) return route.fulfill({ status: 404, body: '{}' });
    const { __status, body } = (a && typeof a === 'object' && '__status' in a ? a : { __status: 200, body: a }) as { __status: number; body: unknown };
    return route.fulfill({ status: __status, contentType: 'application/json', body: JSON.stringify(body) });
  });
  // a fresh document every time: the confirm page strips its `#code` off the address, so the same URL again would be a fragment
  // change only (no load — the last scene's React tree would stay)
  await page.goto('about:blank');
  await page.goto(`http://preview.test/${o.hash ?? ''}`);
  if (o.phone) await page.evaluate(() => { (window as unknown as { __phone: boolean }).__phone = true; });
  // a module the stubs miss can throw while the bundle loads — then `__mount` is never set. Say what threw, by name, instead of
  // «__mount is not a function» (story #4583: the inbox gained remote-off.tsx's imports and this harness only said that)
  const thrown: string[] = [];
  page.on('pageerror', (e) => thrown.push(e.message));
  await page.addScriptTag({ content: js });
  if (!(await page.evaluate(() => typeof (window as unknown as { __mount?: unknown }).__mount === 'function'))) {
    throw new Error(`the bundle did not start — likely a module to stub (STUBS): ${thrown.join(' | ') || 'no page error'}`);
  }
  await page.evaluate(([k, l]) => (window as unknown as { __mount: (k: string, l: string) => void }).__mount(k, l), [o.kind, o.locale ?? 'ko']);
}

const frames = (page: Page) => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(1)))));
// story #4600 (Yuna): a pixel equality test must wait for the element's transitions to finish, not just two frames — the shadcn
// Switch has `transition-all` (150 ms) on its ring, so two frames after focus/blur read a mid-transition blend and the L-390 cell
// went red or green by timing (4980 1ba85a88a red · the same job rerun green). Every running animation on the element and its
// subtree, then two frames so the final state is painted.
const settled = async (page: Page, el: Locator) => {
  await el.evaluate((node) => Promise.all(node.getAnimations({ subtree: true }).map((a) => a.finished.catch(() => undefined))));
  await frames(page);
};
const outDir = () => { const d = process.env['CAPTURE_OUT'] || test.info().outputDir; mkdirSync(d, { recursive: true }); return d; };
async function shot(page: Page, target: Locator, name: string) {
  await target.scrollIntoViewIfNeeded();
  await page.mouse.move(0, 0); // no hover paint (Yuna 4972 ②)
  await frames(page);
  await target.screenshot({ path: path.join(outDir(), `${name}.png`) });
}

/** the contrast of a line's text on its own background, from the shot's pixels (background = its most common colour, text = the
 *  pixel farthest from it in luminance) — not from tokens (Yuna's list) */
async function pixelContrast(page: Page, line: Locator, name: string): Promise<number> {
  await line.scrollIntoViewIfNeeded();
  await page.mouse.move(0, 0);
  await frames(page);
  const png = (await line.screenshot()).toString('base64');
  const ratio = await page.evaluate(async (b64) => {
    const img = new Image();
    img.src = `data:image/png;base64,${b64}`;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.width; c.height = img.height;
    const g = c.getContext('2d')!;
    g.drawImage(img, 0, 0);
    const d = g.getImageData(0, 0, c.width, c.height).data;
    const lum = (r: number, gg: number, b: number) => {
      const f = (v: number) => { const s = v / 255; return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
      return 0.2126 * f(r) + 0.7152 * f(gg) + 0.0722 * f(b);
    };
    const counts = new Map<string, number>();
    for (let i = 0; i < d.length; i += 4) { const k = `${d[i]},${d[i + 1]},${d[i + 2]}`; counts.set(k, (counts.get(k) ?? 0) + 1); }
    const bg = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]![0].split(',').map(Number);
    const lb = lum(bg[0]!, bg[1]!, bg[2]!);
    let best = 1;
    for (let i = 0; i < d.length; i += 4) {
      const l = lum(d[i]!, d[i + 1]!, d[i + 2]!);
      const r = (Math.max(l, lb) + 0.05) / (Math.min(l, lb) + 0.05);
      if (r > best) best = r;
    }
    return best;
  }, png);
  appendFileSync(path.join(outDir(), 'contrast.json'), `${JSON.stringify({ name, ratio: Math.round(ratio * 100) / 100 })}\n`);
  return ratio;
}

/** the link takes its own row under the line (never inline — Yuna ②) */
async function linkOnItsOwnRow(line: Locator, link: Locator) {
  const [a, b] = [await line.boundingBox(), await link.boundingBox()];
  expect(a && b, 'line and link both drawn').toBeTruthy();
  expect(b!.y, 'the link starts below the line').toBeGreaterThanOrEqual(a!.y + a!.height - 1);
}

// ── fixtures (Yuna's list) ──────────────────────────────────────────────────────────────────────────────────────────────────
const NAMES3 = ['송윤재', '윤도선', '김하나'];
const NAMES3_EN = ['Song Yunjae', 'Yun Doseon', 'Kim Hana'];
const org = (o: { owner: boolean; names?: string[]; computers?: number; on?: boolean }) => ({
  'GET /api/organizations/org-1/remote-control': { data: {
    enabled: !!o.on, enabled_at: o.on ? '2026-10-07T01:00:00Z' : null, can_change: o.owner,
    owner_names: o.names ?? NAMES3, connected_computers: o.computers ?? 1,
  } },
});
const REQUEST = {
  id: 'r1', request_id: 'q1', setup_id: 's1', device_name: 'SYJ-MacBook-Pro', agent_member_id: 'a1', agent_name: 'Dev', role: '개발',
  tool: 'Bash', summary: 'npm install', masked: false, truncated: false, workdir: '~/Sprintable/블로그 글',
  created_at: new Date(Date.now() - 60_000).toISOString(), expires_at: new Date(Date.now() + 1_800_000).toISOString(), state: 'pending',
  answered_by_name: null, decision: null, device_reachable: true, recipient_reason: 'paired', answerable: true, session_key: 's-1',
  input_hash: `sha256:${'a'.repeat(64)}`,
};
const pairApi = (o: Parameters<typeof org>[0], offer: Answer) => ({
  ...org(o),
  'POST /api/remote-devices': { __status: 201, body: { id: '7d1e9c2a-aaaa-4bbb-8ccc-dddddddddddd' } },
  'GET /api/remote-devices': { devices: [] },
  'POST /api/remote-devices/pairing-offers': offer,
});
const OFFER_OFF = { __status: 409, body: { error: { code: 'remote_control_off', message: 'off' } } };
const remoteApi = (o: Parameters<typeof org>[0]) => ({
  ...org(o),
  'POST /api/desktop/device-token-codes/peek': o.on
    ? { device_name: 'SYJ-MacBook-Pro', org_name: '문클랩스', expires_at: new Date(Date.now() + 300_000).toISOString() }
    : { __status: 409, body: { error: { code: 'remote_control_off', message: 'off' } } },
});
const CODE = `#code=${'c'.repeat(24)}`;
const stripApi = (o: Parameters<typeof org>[0], state = 'working') => ({
  ...org(o),
  'GET /api/agents/a1/desktop-session': { device_name: 'SYJ-MacBook-Pro', state, remote_control: !!o.on, pending_permission_request_id: null },
});
const inboxApi = (o: Parameters<typeof org>[0]) => ({ ...org(o), 'GET /api/agent-permission-requests': { requests: [REQUEST] } });

// ── the copy (Yuna `4583/copy.md`) ───────────────────────────────────────────────────────────────────────────────────────────
const KO = {
  pairOwner: '원격 제어가 꺼져 있어 짝지을 수 없어요 — 켜면 이 폰에서 에이전트에 답하고, 멈추거나 지시할 수 있어요',
  pairMember: (o: string) => `원격 제어가 꺼져 있어 짝지을 수 없어요 — 조직 소유자${o}가 켜면 다시 할 수 있어요`,
  remoteOwner: '이 조직은 원격 제어가 꺼져 있어 이 컴퓨터를 켤 수 없어요 — 조직의 원격 제어를 먼저 켜 주세요',
  remoteMember: (o: string) => `이 조직은 원격 제어가 꺼져 있어 이 컴퓨터를 켤 수 없어요 — 조직 소유자${o}가 켜면 다시 할 수 있어요`,
  stripOwner: '원격 제어가 꺼져 있어 폰에서 멈추거나 지시할 수 없어요',
  stripMember: (o: string) => `원격 제어가 꺼져 있어 폰에서 멈추거나 지시할 수 없어요 — 조직 소유자${o}가 켤 수 있어요`,
  inboxOwner: '원격 제어가 꺼져 있어 데스크톱 에이전트의 권한 요청이 여기로 오지 않아요',
  inboxMember: (o: string) => `원격 제어가 꺼져 있어 데스크톱 에이전트의 권한 요청이 여기로 오지 않아요 — 조직 소유자${o}가 켤 수 있어요`,
  offEffect: '꺼져 있으면 권한 요청이 폰으로 오지 않고, 폰에서 멈추거나 지시할 수도 없어요',
  ownerOnlyOff: (o: string) => `원격 제어 · 꺼짐 — 조직 소유자${o}만 켜고 끌 수 있어요`,
  ownerOnlyOn: (o: string) => `원격 제어 · 켜짐 — 조직 소유자${o}만 켜고 끌 수 있어요`,
  link: '원격 제어 켜러 가기',
};
const THREE = '(송윤재 외 2명)';
const NEW_LINES = [KO.pairOwner, KO.remoteOwner, KO.stripOwner, KO.inboxOwner, KO.offEffect, KO.link, '오지 않아요', '켤 수 없어요', '짝지을 수 없어요'];

for (const width of [1440, 390]) for (const theme of ['L', 'D'] as const) {
  const tag = `${theme}-${width}`;

  test(`[4583] ① pairing · ② /desktop/remote refused · ${tag}`, async ({ page }) => {
    if (width === 390) { // ① is the phone's page: 390 only
      await open(page, { kind: 'pair', width, theme, phone: true, api: pairApi({ owner: true }, OFFER_OFF) });
      await page.getByRole('button', { name: 'QR 찍기' }).click();
      await page.getByRole('button', { name: '짝짓기' }).click();
      const card = page.getByTestId('phone-pairing');
      const line = page.getByTestId('phone-pairing-line');
      await expect(line).toHaveText(KO.pairOwner);
      await expect(card.locator('a, button')).toHaveText([KO.link, '닫기']);
      await linkOnItsOwnRow(line, page.getByTestId('remote-off-link'));
      expect(await pixelContrast(page, line, `1a-${tag}`)).toBeGreaterThanOrEqual(4.5);
      await shot(page, card, `4583-web-1a-pair-refused-owner-${tag}`);

      await open(page, { kind: 'pair', width, theme, phone: true, api: pairApi({ owner: false }, OFFER_OFF) });
      await page.getByRole('button', { name: 'QR 찍기' }).click();
      await page.getByRole('button', { name: '짝짓기' }).click();
      await expect(page.getByTestId('phone-pairing-line')).toHaveText(KO.pairMember(THREE));
      await expect(page.getByTestId('phone-pairing').locator('a, button')).toHaveText(['닫기']);
      await shot(page, page.getByTestId('phone-pairing'), `4583-web-1b-pair-refused-member-${tag}`);

      await open(page, { kind: 'pair', width, theme, phone: true, api: pairApi({ owner: false, names: [] }, OFFER_OFF) });
      await page.getByRole('button', { name: 'QR 찍기' }).click();
      await page.getByRole('button', { name: '짝짓기' }).click();
      await expect(page.getByTestId('phone-pairing-line')).toHaveText(KO.pairMember(''));
      await shot(page, page.getByTestId('phone-pairing'), `4583-web-6-pair-no-names-member-${tag}`);
    }

    await open(page, { kind: 'remote', width, theme, hash: CODE, api: remoteApi({ owner: true }) });
    const rLine = page.getByRole('status');
    await expect(rLine).toHaveText(KO.remoteOwner);
    await linkOnItsOwnRow(rLine, page.getByTestId('remote-off-link'));
    await expect(page.getByTestId('remote-off-link')).toHaveAttribute('href', '/desktop#remote-control');
    expect(await pixelContrast(page, rLine, `2a-${tag}`)).toBeGreaterThanOrEqual(4.5);
    await shot(page, rLine.locator('xpath=ancestor::*[@data-slot="card"][1]'), `4583-web-2a-remote-refused-owner-${tag}`);

    await open(page, { kind: 'remote', width, theme, hash: CODE, api: remoteApi({ owner: false }) });
    await expect(page.getByRole('status')).toHaveText(KO.remoteMember(THREE));
    await expect(page.getByTestId('remote-off-link')).toHaveCount(0);
    await shot(page, page.getByRole('status').locator('xpath=ancestor::*[@data-slot="card"][1]'), `4583-web-2b-remote-refused-member-${tag}`);
  });

  test(`[4583] ③ chat strip · ${tag}`, async ({ page }) => {
    const strip = () => page.getByTestId('agent-session-line').locator('xpath=ancestor::*[.//*[@data-testid="agent-session-chip"]][1]');
    await open(page, { kind: 'strip', width, theme, api: stripApi({ owner: true }) });
    const line = page.getByTestId('agent-session-line');
    await expect(line).toHaveText(KO.stripOwner);
    await linkOnItsOwnRow(line, page.getByTestId('remote-off-link'));
    expect(await pixelContrast(page, line, `3a-${tag}`)).toBeGreaterThanOrEqual(4.5);
    await shot(page, strip(), `4583-web-3a-strip-working-owner-${tag}`);

    await open(page, { kind: 'strip', width, theme, api: stripApi({ owner: false }) });
    await expect(page.getByTestId('agent-session-line')).toHaveText(KO.stripMember(THREE));
    await expect(page.getByTestId('remote-off-link')).toHaveCount(0);
    await shot(page, strip(), `4583-web-3b-strip-working-member-${tag}`);

    await open(page, { kind: 'strip', width, theme, api: stripApi({ owner: false, names: [] }) });
    await expect(page.getByTestId('agent-session-line')).toHaveText(KO.stripMember(''));
    await shot(page, strip(), `4583-web-6-strip-no-names-member-${tag}`);

    await open(page, { kind: 'strip', width, theme, api: stripApi({ owner: true }, 'idle') });
    const chip = page.getByTestId('agent-session-chip');
    await expect(chip).toBeVisible();
    await expect(page.getByTestId('agent-session-line')).toHaveCount(0); // not in the DOM — not hidden
    await expect(page.getByTestId('remote-off-link')).toHaveCount(0);
    await shot(page, chip.locator('xpath=..').locator('xpath=..'), `4583-web-3c-strip-idle-owner-${tag}`);
  });

  test(`[4583] ④ 결재함 · ${tag}`, async ({ page }) => {
    for (const phone of width === 390 ? [false, true] : [false]) {
      const where = phone ? 'phone' : 'web';
      await open(page, { kind: 'inbox', width, theme, phone, api: inboxApi({ owner: true }) });
      const off = page.getByTestId('agent-permission-remote-off');
      await expect(off.locator('p')).toHaveText(KO.inboxOwner);
      await linkOnItsOwnRow(off.locator('p'), off.getByTestId('remote-off-link'));
      // above the agent requests, not between them
      const [o, list] = [await off.boundingBox(), await page.getByTestId('agent-permission-requests').boundingBox()];
      expect(o!.y + o!.height).toBeLessThanOrEqual(list!.y + 1);
      expect(await pixelContrast(page, off.locator('p'), `4a-${where}-${tag}`)).toBeGreaterThanOrEqual(4.5);
      await shot(page, page.locator('#root'), `4583-web-4a-inbox-${where}-owner-${tag}`);

      await open(page, { kind: 'inbox', width, theme, phone, api: inboxApi({ owner: false }) });
      await expect(page.getByTestId('agent-permission-remote-off')).toHaveText(KO.inboxMember(THREE));
      await shot(page, page.locator('#root'), `4583-web-4b-inbox-${where}-member-${tag}`);
    }
    await open(page, { kind: 'inbox', width, theme, api: inboxApi({ owner: true, computers: 0 }) });
    await expect(page.getByTestId('agent-permission-requests')).toBeVisible();
    await expect(page.getByTestId('agent-permission-remote-off')).toHaveCount(0);
    await shot(page, page.locator('#root'), `4583-web-4c-inbox-no-computer-owner-${tag}`);
  });

  test(`[4583] ⑤ /desktop card · arrival from the link · ${tag}`, async ({ page }) => {
    const card = page.getByTestId('desktop-remote-control');
    await open(page, { kind: 'card', width, theme, api: org({ owner: true }) });
    await expect(card).toHaveAttribute('id', 'remote-control');
    await expect(page.getByTestId('desktop-remote-control-off-effect')).toHaveText(KO.offEffect);
    await expect(page.getByTestId('desktop-remote-control-owner-only')).toHaveCount(0);
    await expect(card.locator('[data-slot="switch"]')).toHaveAttribute('aria-checked', 'false');
    expect(await pixelContrast(page, page.getByTestId('desktop-remote-control-off-effect'), `5a-${tag}`)).toBeGreaterThanOrEqual(4.5);
    await shot(page, card, `4583-web-5a-card-owner-${tag}`);

    await open(page, { kind: 'card', width, theme, api: org({ owner: false }) });
    await expect(page.getByTestId('desktop-remote-control-owner-only')).toHaveText(KO.ownerOnlyOff(THREE));
    await expect(card.locator('[data-slot="switch"]')).toHaveCount(0);
    expect(await pixelContrast(page, page.getByTestId('desktop-remote-control-owner-only'), `5b-${tag}`)).toBeGreaterThanOrEqual(4.5);
    await shot(page, card, `4583-web-5b-card-member-${tag}`);

    await open(page, { kind: 'card', width, theme, api: org({ owner: false, names: [] }) });
    await expect(page.getByTestId('desktop-remote-control-owner-only')).toHaveText(KO.ownerOnlyOff(''));
    await shot(page, card, `4583-web-6-card-no-names-member-${tag}`);

    await open(page, { kind: 'card', width, theme, api: org({ owner: false, names: ['송윤재', '윤도선'] }) });
    await expect(page.getByTestId('desktop-remote-control-owner-only')).toHaveText(KO.ownerOnlyOff('(송윤재 · 윤도선)'));
    await shot(page, card, `4583-web-6b-card-two-names-member-${tag}`);

    // 5c — the owner arrives at /desktop#remote-control from far below: the card in view, the switch focused with a visible ring, still off
    await open(page, { kind: 'card-far', width, theme, hash: '#remote-control', api: org({ owner: true }) });
    const sw = card.locator('[data-slot="switch"]');
    await expect(sw).toBeFocused();
    await expect(sw).toHaveAttribute('aria-checked', 'false');
    await page.mouse.move(0, 0);
    await frames(page);
    const box = (await card.boundingBox())!;
    expect(box.y >= 0 && box.y + box.height <= (page.viewportSize()!.height + 1), 'the card is in view').toBe(true);
    const s = (await sw.boundingBox())!;
    const clip = { x: Math.max(0, s.x - 6), y: Math.max(0, s.y - 6), width: s.width + 12, height: s.height + 12 };
    await settled(page, sw); // story #4600: the ring's 150 ms transition has ended — the focused shot is the final ring, not a blend
    const focused = await page.screenshot({ clip });
    await page.screenshot({ path: path.join(outDir(), `4583-web-5c-arrive-owner-${tag}.png`) });
    // story #4600: a bare `blur()` is undone by the card's arrival hold — `holdArrivalFocus` puts the focus back on the switch for
    // 1.5 s whenever it falls to the page — so the ring came straight back and the «blurred» shot was another mid-transition blend
    // (equal to the focused blend now and then: the L-390 red). Move the focus to another element instead: by the hold's own rule
    // the mark comes off and the hold ends, and the ring's transition out can finish before the shot.
    await page.evaluate(() => {
      const away = document.createElement('button');
      away.id = '__away'; away.textContent = 'away'; away.style.position = 'fixed'; away.style.left = '-9999px'; away.style.top = '0';
      document.body.appendChild(away); away.focus();
    });
    await expect(sw).not.toBeFocused();
    await settled(page, sw);
    const blurred = await page.screenshot({ clip });
    await page.evaluate(() => document.getElementById('__away')?.remove());
    expect(focused.equals(blurred), 'the focus ring shows in pixels').toBe(false);

    await open(page, { kind: 'card-far', width, theme, hash: '#remote-control', api: org({ owner: false }) });
    await expect(card).toBeFocused();
    await page.mouse.move(0, 0);
    await frames(page);
    const b2 = (await card.boundingBox())!;
    expect(b2.y >= 0 && b2.y + b2.height <= (page.viewportSize()!.height + 1), 'the card is in view').toBe(true);
    await page.screenshot({ path: path.join(outDir(), `4583-web-5d-arrive-member-${tag}.png`) });
  });
}

// Yuna 4974: a mouse press on the 결재함 link → the card in an in-app navigation — :focus-visible is false after a pointer press,
// so the ring must come from data-arrived (the same tokens). Measured as the switch's computed box-shadow, not as activeElement.
for (const theme of ['L', 'D'] as const) {
  test(`[4583] ⑤e arrival by a mouse press on the link (in-app) · the ring shows · ${theme} · 1440`, async ({ page }) => {
    await open(page, { kind: 'inbox', width: 1440, theme, api: inboxApi({ owner: true }) });
    const link = page.getByTestId('remote-off-link');
    const box = (await link.boundingBox())!;
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    const sw = page.getByTestId('desktop-remote-control').locator('[data-slot="switch"]');
    await sw.waitFor();
    await expect(sw).toBeFocused();
    await expect(sw).toHaveAttribute('aria-checked', 'false');
    await expect(sw).toHaveAttribute('data-arrived', '');
    expect(await sw.evaluate((el) => el.matches(':focus-visible')), 'the browser does not call it focus-visible after a pointer press').toBe(false);
    const ring = await sw.evaluate((el) => getComputedStyle(el).boxShadow);
    expect(ring, 'the arrival ring is drawn').not.toBe('none');
    await page.mouse.move(0, 0);
    await frames(page);
    await page.screenshot({ path: path.join(outDir(), `4583-web-5e-arrive-by-mouse-owner-${theme}-1440.png`) });
    await page.keyboard.press('Shift'); // the person acts → the mark comes off (the browser's own rules from here)
    await expect(sw).not.toHaveAttribute('data-arrived', '');
  });
}

test('[4583] ⑦ on — none of the new lines in any place · 1440 L', async ({ page }) => {
  const w = 1440; const theme = 'L';
  const none = async (name: string, target: Locator) => {
    await expect(page.getByTestId('remote-off-link')).toHaveCount(0);
    const text = await page.locator('#root').innerText();
    for (const l of NEW_LINES) expect(text, `${name}: «${l}»`).not.toContain(l);
    await shot(page, target, `4583-web-7-${name}-on-L-1440`);
  };
  for (const owner of [true, false]) {
    const who = owner ? 'owner' : 'member';
    await open(page, { kind: 'pair', width: w, theme, phone: true, api: pairApi({ owner, on: true }, { __status: 202, body: { state: 'sent' } }) });
    await none(`pair-${who}`, page.getByTestId('phone-pairing'));
    await open(page, { kind: 'remote', width: w, theme, hash: CODE, api: remoteApi({ owner, on: true }) });
    await expect(page.getByRole('button', { name: '켜기' })).toBeVisible();
    await none(`remote-${who}`, page.locator('#root'));
    await open(page, { kind: 'strip', width: w, theme, api: stripApi({ owner, on: true }) });
    await expect(page.getByTestId('agent-session-chip')).toBeVisible();
    await none(`strip-${who}`, page.locator('#root'));
    await open(page, { kind: 'inbox', width: w, theme, api: inboxApi({ owner, on: true }) });
    await expect(page.getByTestId('agent-permission-requests')).toBeVisible();
    await expect(page.getByTestId('agent-permission-remote-off')).toHaveCount(0);
    await none(`inbox-${who}`, page.locator('#root'));
    await open(page, { kind: 'card', width: w, theme, api: org({ owner, on: true }) });
    await expect(page.getByTestId('desktop-remote-control-off-effect')).toHaveCount(0);
    if (!owner) await expect(page.getByTestId('desktop-remote-control-owner-only')).toHaveText(KO.ownerOnlyOn(THREE)); // the existing «켜짐» line, now named
    await none(`card-${who}`, page.getByTestId('desktop-remote-control'));
  }
});

test('[4583] ⑧ en — 1a · 4a · 5b · 1440 L', async ({ page }) => {
  const w = 1440; const theme = 'L'; const locale = 'en' as const;
  await open(page, { kind: 'pair', width: w, theme, phone: true, locale, api: pairApi({ owner: true, names: NAMES3_EN }, OFFER_OFF) });
  await page.getByRole('button', { name: 'Scan QR' }).click();
  await page.getByRole('button', { name: 'Pair' }).click();
  await expect(page.getByTestId('phone-pairing-line')).toHaveText("Remote control is off, so this phone can't be paired — turn it on to answer, stop and instruct agents from this phone");
  await expect(page.getByTestId('phone-pairing').locator('a, button')).toHaveText(['Go to remote control', 'Close']);
  await shot(page, page.getByTestId('phone-pairing'), '4583-web-8-pair-refused-owner-en-L-1440');

  await open(page, { kind: 'inbox', width: w, theme, locale, api: inboxApi({ owner: true, names: NAMES3_EN }) });
  await expect(page.getByTestId('agent-permission-remote-off').locator('p')).toHaveText("Remote control is off, so desktop agents' permission requests don't come here");
  await shot(page, page.locator('#root'), '4583-web-8-inbox-owner-en-L-1440');

  await open(page, { kind: 'card', width: w, theme, locale, api: org({ owner: false, names: NAMES3_EN }) });
  await expect(page.getByTestId('desktop-remote-control-owner-only')).toHaveText('Remote control · off — only an organization owner (Song Yunjae and 2 others) can turn it on or off');
  await shot(page, page.getByTestId('desktop-remote-control'), '4583-web-8-card-member-en-L-1440');
});
