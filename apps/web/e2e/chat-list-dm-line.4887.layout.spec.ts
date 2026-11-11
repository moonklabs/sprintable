/**
 * story 4887 (UI-4 P2-e) — the DM row of the chat list, measured in Chromium: the real `ChatListView` (bundled with esbuild, not copied) and the real Tailwind build of globals.css; only the shell's answers are made up
 * (the dashboard context, the router, the realtime hooks, and the conversations the API returns).
 * The rule under test: when the row's title already says who the room is with, the line does NOT repeat the name — so the «에이전트» chip and the computer chip get the width and the computer's name is READ, not cut to «AC…»
 * (dev measured: `나 ↔ Any ·…` + «에이전트» + `AC…` at the 270 px list). When the title is something else, the other's NAME stays (never «나 ↔»).
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

const COMPUTER = 'SYJ-Mac'; // a short computer name — it must be read in full whatever the font (the widths of longer names depend on the font, so they are compared between rows, not against pixels)
const AGENT_NAME = 'Any · SYJ'; // «role · install name» — an agent display name
const LONG_COMPUTER = 'AC4 isolated daemon'; // the long name of the dev measurement's computer (19 characters)
const LONG_AGENT_NAME = 'Lead · AC4 isolated daemon'; // AC1 19: «role · install name»
const ME = { member_id: 'me-1', name: '나', type: 'human' };
const AGENT = { member_id: 'a-1', name: AGENT_NAME, type: 'agent', runtime_type: 'claude-code', device_name: COMPUTER };
const LONG_AGENT = { member_id: 'a-3', name: LONG_AGENT_NAME, type: 'agent', runtime_type: 'claude-code', device_name: LONG_COMPUTER };
const room = (id: string, title: string | null, participants: object[], at: string) => ({
  id, type: 'dm', title, participants, latest_message: { content: '안녕하세요', created_at: at }, updated_at: at, unread_count: 0, project_id: 'p1', project_name: 'P',
});
const CONVERSATIONS = [
  room('c-agent', null, [ME, AGENT], '2026-11-10T03:00:00Z'), // title = the agent's own display name → no name on the line
  room('c-long', null, [ME, LONG_AGENT], '2026-11-10T03:30:00Z'), // the same with the long names of the dev measurement
  room('c-long-named', '점검 도우미', [ME, { ...LONG_AGENT, member_id: 'a-4' }], '2026-11-10T03:15:00Z'), // the SAME agent and computer in a DM the people named → the name stays on the line, so the chip gets less
  room('c-named', '배포 도우미', [ME, { ...AGENT, member_id: 'a-2' }], '2026-11-10T02:00:00Z'), // a DM the people named → the agent's name stays
  room('c-human', null, [ME, { member_id: 'h-1', name: '지우', type: 'human' }], '2026-11-10T01:00:00Z'), // a person → no line at all
];

let built: { js: string; css: string } | null = null;
async function build() {
  if (built) return built;
  const esbuild = req('esbuild') as typeof import('esbuild');
  const bodies: Record<string, string> = {
    '@/components/realtime-provider': 'export function useSseMultiplexerContext() { return { isAlive: () => false, subscribe: () => () => {}, subscribeMessage: () => () => {}, subscribeReconnect: () => () => {}, connected: true }; }',
    '@/hooks/use-chat-sse': 'export function useChatSse() { return { connected: true, polling: false }; } export const isOwnMessage = () => false;',
    '@/hooks/use-auto-refresh': 'export function useAutoRefresh() {}',
    '@/app/dashboard/dashboard-shell': "export function useDashboardContext() { return { orgId: 'org-1', currentTeamMemberId: 'me-1', projectId: 'p1', role: 'member', projectMemberships: [{ projectId: 'p1', projectName: 'P' }, { projectId: 'p2', projectName: 'Q' }], orgMemberships: [] }; }",
    'next/navigation': "export function useRouter() { return { push() {}, replace() {}, back() {}, refresh() {}, prefetch() {} }; } export function useSearchParams() { return new URLSearchParams(''); } export function usePathname() { return '/chats'; } export function useParams() { return {}; } export function useSelectedLayoutSegment() { return null; } export function useSelectedLayoutSegments() { return []; } export function redirect() {} export function notFound() {}",
  };
  const filter = new RegExp(`^(${Object.keys(bodies).map((k) => k.replace(/[/.-]/g, '\\$&')).join('|')})$`);
  const out = await esbuild.build({
    stdin: {
      contents: `
        import React from 'react'; import { createRoot } from 'react-dom/client'; import { NextIntlClientProvider } from 'next-intl';
        import ko from './messages/ko.json';
        import { ChatListView } from './src/components/chat/chat-list-view';
        window.__mount = (w) => {
          createRoot(document.getElementById('root')).render(React.createElement(NextIntlClientProvider, { locale: 'ko', messages: ko, timeZone: 'Asia/Seoul' },
            React.createElement('div', { id: 'rail', style: { width: (w || 270) + 'px', padding: '0 8px' } }, React.createElement(ChatListView, { projectId: 'p1', currentTeamMemberId: 'me-1' }))));
        };`,
      resolveDir: WEB, loader: 'tsx',
    },
    bundle: true, format: 'iife', platform: 'browser', write: false, logLevel: 'silent', jsx: 'automatic',
    tsconfig: path.join(WEB, 'tsconfig.json'),
    define: { 'process.env.NODE_ENV': '"production"', 'process.env.NEXT_PUBLIC_APP_URL': '"https://app.sprintable.ai"' },
    plugins: [
      { name: 'dm-line-4887-stubs', setup(b) {
        b.onResolve({ filter }, (a) => ({ path: a.path, namespace: 'stub4887' }));
        b.onLoad({ filter: /.*/, namespace: 'stub4887' }, (a) => ({ contents: bodies[a.path]!, loader: 'js', resolveDir: WEB }));
        // the two strips above the list are not what is measured here: they read other endpoints and the refresh context
        b.onResolve({ filter: /^\.\/(now-strip|pulse-card)$/ }, (a) => ({ path: a.path, namespace: 'strip4887' }));
        b.onLoad({ filter: /.*/, namespace: 'strip4887' }, (a) => ({ contents: a.path.includes('now-strip') ? 'export function NowStrip() { return null; }' : 'export function PulseCard() { return null; }', loader: 'js', resolveDir: WEB }));
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

async function open(page: Page, width?: number) {
  const { js, css } = await build();
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.unrouteAll();
  await page.route('http://preview.test/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/') {
      return route.fulfill({ contentType: 'text/html', body: `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head><body class="bg-background text-foreground"><div id="root"></div></body></html>` });
    }
    const json = (b: unknown) => route.fulfill({ contentType: 'application/json', body: JSON.stringify(b) });
    if (url.pathname === '/api/conversations') return json({ data: CONVERSATIONS, total: CONVERSATIONS.length });
    if (url.pathname.startsWith('/api/conversations/recent-outside-project')) return json({ data: [] });
    return route.fulfill({ status: 404, body: '{}' });
  });
  await page.goto('about:blank');
  await page.goto('http://preview.test/');
  await page.addScriptTag({ content: js });
  await page.evaluate((w) => (window as unknown as { __mount: (w?: number) => void }).__mount(w), width);
  await page.getByTestId('device-chip').first().waitFor();
}

const rowOf = (page: Page, text: string) => page.locator('button', { hasText: text }).first();

/** the computer chip of the row whose title is `title`, as the browser lays it out */
async function chipOf(page: Page, title: string) {
  return page.evaluate(({ t }) => {
    const row = [...document.querySelectorAll('button')].find((b) => b.querySelector('.truncate.text-sm.font-semibold')?.textContent === t) as HTMLElement;
    const line = row.querySelector('[data-testid="room-dm-line"]') as HTMLElement;
    const chip = line.querySelector('[data-testid="device-chip"]') as HTMLElement;
    const text = chip.querySelector('.truncate') as HTMLElement;
    const col = (row.querySelector('p.truncate.text-xs') as HTMLElement).getBoundingClientRect();
    const lr = line.getBoundingClientRect(); const cr = chip.getBoundingClientRect();
    return { other: line.querySelector('[data-testid="room-dm-other"]') !== null, textCut: text.scrollWidth > text.clientWidth, textW: Math.round(text.clientWidth), fullW: Math.round(text.scrollWidth), chipW: Math.round(cr.width), chipInsideLine: cr.right <= lr.right + 0.5, lineW: Math.round(lr.width), colW: Math.round(col.width), lineOverflow: line.scrollWidth > line.clientWidth, title: chip.getAttribute('title') };
  }, { t: title });
}

test('[SID:4887] the agent DM titled with the agent\'s name has no name on the line — a short computer name is READ in full at the real list width', async ({ page }) => {
  await open(page);
  const g = await chipOf(page, AGENT_NAME);
  expect(g.other, 'no name segment: the title already says it').toBe(false);
  expect(g.textCut, `the computer's name is cut (text ${g.textW}px of ${g.fullW}px, chip ${g.chipW}px, line ${g.lineW}px)`).toBe(false);
  expect(g.chipInsideLine, 'the chip ends inside the line').toBe(true);
  expect(g.lineOverflow, 'the line does not run past its column').toBe(false);
  expect(g.colW, 'the measured text column is the real one (dev measured 179 px)').toBeGreaterThan(150);
  expect(g.colW).toBeLessThan(210);
});

test('[SID:4887] dropping the repeated name gives the computer chip the width: the same long computer is read much further in the unnamed DM than in the named one', async ({ page }) => {
  await open(page);
  const unnamed = await chipOf(page, LONG_AGENT_NAME); // title = the agent's name → no name on the line
  const named = await chipOf(page, '점검 도우미'); // a DM the people named → the agent's name is on the line
  expect(unnamed.other).toBe(false);
  expect(named.other).toBe(true);
  expect(unnamed.title).toBe(LONG_COMPUTER); // the whole name stays in the title either way
  expect(named.title).toBe(LONG_COMPUTER);
  // the chip's visible text: the name segment's width goes to the chip (reverted — the name always on the line — both rows are equal → this fails)
  expect(unnamed.textW, `unnamed ${unnamed.textW}px vs named ${named.textW}px of ${unnamed.fullW}px`).toBeGreaterThanOrEqual(named.textW + 20);
  expect(unnamed.chipInsideLine && named.chipInsideLine).toBe(true);
  expect(unnamed.lineOverflow || named.lineOverflow).toBe(false);
});

test('[SID:4887] the DM the people named keeps the agent\'s NAME on the line (never «나 ↔»), inside the column', async ({ page }) => {
  await open(page);
  const row = rowOf(page, '배포 도우미');
  await expect(row.getByTestId('room-dm-other')).toHaveText(AGENT_NAME);
  await expect(row.getByTestId('room-dm-line')).not.toContainText('나 ↔');
  const over = await row.getByTestId('room-dm-line').evaluate((l) => (l as HTMLElement).scrollWidth > (l as HTMLElement).clientWidth);
  expect(over, 'the line does not run past its column').toBe(false);
});

test('[SID:4887] a person\'s DM has no participant line at all and is the shortest row', async ({ page }) => {
  await open(page);
  const h = await page.evaluate(() => Object.fromEntries([...document.querySelectorAll('button')].filter((b) => b.querySelector('.truncate.text-sm.font-semibold')).map((b) => [b.querySelector('.truncate.text-sm.font-semibold')!.textContent, Math.round(b.getBoundingClientRect().height)])));
  const human = rowOf(page, '지우');
  await expect(human.getByTestId('room-dm-line')).toHaveCount(0);
  expect(h['지우']!, 'a row without the participant line is shorter than one with it').toBeLessThan(h[AGENT_NAME]!);
});

// story 4887 (UI-4 P6-b) — the list slot is narrower between lg and xl (read from chats/layout.tsx, not typed here): at THAT width the list must read exactly as it does at 270 — the short computer name in full, the same cut rows.
// (Measured over ten rows on a Mac: 232 px and up cut 4 titles · 3 previews · 4 computer names · 2 agent names · 0 project names, the same as 270; 224 px newly cuts «SYJ-Mac» and a project name. The CI's wider Linux font cuts «SYJ-Mac» at 232 (32 of 41 px), which is why the slot is 248.)
const LG_LIST_WIDTH = Number(/lg:w-\[(\d+)px\] xl:w-\[270px\]/.exec(readFileSync(path.join(WEB, 'src/app/(authenticated)/chats/layout.tsx'), 'utf8'))?.[1]);

test('[SID:4887] at the narrower lg list width the short computer name is still READ in full and no line runs past its column', async ({ page }) => {
  expect(LG_LIST_WIDTH, 'the lg list width is read from the layout source').toBeGreaterThan(200);
  await open(page, LG_LIST_WIDTH);
  const g = await chipOf(page, AGENT_NAME);
  expect(g.textCut, `«${COMPUTER}» is cut at the ${LG_LIST_WIDTH} px list (text ${g.textW}px of ${g.fullW}px)`).toBe(false); // reverted to 224 → 29 of 36 px
  expect(g.chipInsideLine && !g.lineOverflow).toBe(true);
  const named = await chipOf(page, '배포 도우미');
  expect(named.lineOverflow, 'the named DM line stays inside its column').toBe(false);
});
