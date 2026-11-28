/**
 * story 5031 (C1 [6] · 선생님 지침 «상태 토글») — the four depth-1 places (home · chats · agents · settings) in each of five states (default · loading · empty · error → retry · long text), at 1440 and 390, in ONE spec.
 * The shape of C6's onboarding.5036.states.layout.spec.ts (the REAL components bundled with esbuild — not copied — and the real Tailwind build; no server of ours: the API answers are made here), drawn INSIDE the shell's own class chain
 * (support/shell-scene.ts reads it from the sources) with the REAL top bar · icon rail · phone tab bar around the screen.
 *
 * WHAT IS REAL: the top bar (TopBar) · the icon rail (NavRail) · the phone tab bar (MobileTabBar) · the shell's wrapper / inset / scroller / grid / cell classes (read from sidebar.tsx · dashboard-shell.tsx · contextual-panel-layout.tsx) ·
 *   home: OrgBriefingShell + HomeModelProvider + HomeScreen + ControlBoard · chats: chats/layout.tsx + chats/page.tsx (the REAL route files: ChatListView + the outlet) · agents: WorkforceFrame + AgentManagementTab ·
 *   settings: the REAL settings/page.tsx (nav column + the pane of the chosen tab).
 * WHAT IS NOT (said here so a reader does not take the pictures for more than they are): the list column's CONTENT (AppSidebar — the real one reads the switcher · the whole account; here an EMPTY column of the real width; the settings screen has
 *   its own navigation, so the shell FOLDS the column there — width 0 — as the shell does) · the dashboard context (a small stub: window.__dashboardCtx) · the live streams (SSE: stubbed off) · every server answer · the shell's providers other than the ones above
 *   (no ReleaseNotes · no activation banner · no presence panel).
 *
 *   state \\ place   home                           chats                          agents                              settings
 *   default         needs-hand rows + a working run  five rooms                    four agents                         the profile tab («내 프로필»)  (390: the LIST is the screen)
 *   loading         the model is not there yet       the list is being read        agent-list skeleton                 the profile read is held («불러오는 중…») + the navigation's skeleton rows (admin check pending)
 *   empty           nothing needs a hand («모두 확인») no rooms                      no agents                            the projects tab with no project
 *   error → retry   the read failed + [다시 시도]       the read failed + [다시 시도]    the read failed + [다시 시도]         the profile read failed + [다시 시도]
 *   long text       66-letter names · long titles    long room titles               a 128-letter agent name             long project names (projects tab)
 *   390 · 1440      every scene runs at both
 *   + the home's sixth state, «partial» (codex 6062 round 2): the model is there and a side read (notifications) failed → the list stays and the notice «일부만 불러왔어요 + [다시 시도]» stands over it — its retry is a phone press too.
 * «없음 — 이유»: the settings NAVIGATION column is a static list — it has no empty / error of its own, and its only loading is the skeleton rows (drawn in the settings «loading» scene) — so the settings states are the PANE's, and the pane here is
 *   ONE tab (profile · projects): this is NOT a check of every settings tab. The projects tab does not say a failed read — it draws the empty list (a finding), so the settings «error» is the profile tab's. The home «loading» scene has no spinner text —
 *   its loading is two grey cards. The agents «error» is the route's generic error block (the list's own read failed).
 *
 * Every scene is also an assertion, measured as it is TODAY (nothing is loosened: a number that is not the rule is pinned as the current fact, in BASELINE below, and the scene goes red when it changes):
 *   (a) the place's icon is lit — `aria-current` on the rail (from lg) / the phone tab bar (below) — exactly one · (b) the number of h1 (the rule is 1) · (c) nothing wider than the viewport (the page · the shell's scroller) ·
 *   (d) at 390 every press ≥ 44 px · (e) no text under 12 px · (f) no old (non-ds) part drawn in the body (the shell's own chrome is pinned once: CHROME_OLD).
 * What is measured today and is NOT yet the rule (every entry is a finding — candidate fixes are the PR's, not this spec's):
 *   · h1: home 1 · chats 1 · agents 1 · settings 1 at 1440 and on the phone's list; the settings PANE on a phone has 0 (its title is a span in the pane head) — pinned `h1: 0`, becomes 1 when fixed.
 *   · dupTitle: the settings navigation's h1 «설정» says what the bar's path already says («설정 › 프로필») — the title twice (report only, not fixed in this PR). The HOME body's h1 is `lg:sr-only` from lg now (still THE one h1; the bar's crumb is the only visible «홈») — measured on DRAWN h1s, so the home entry is gone from BASELINE and a drawn h1 again goes RED.
 *   · the 5031 screen fixes this spec guards (not BASELINE any more): every press ≥ 44 at 390 except the pinned ones below (home «대화 열기» / «다시 시도», the chats retry = ds button — the finger REACHES them, measured by `elementFromPoint`) · chats error = ONE retry press (a button; the outlet says the sentence only) · agents «전체 보기» strip on ONE line at 1440 (the caption stands above it).
 *   · still pinned (known limits): avatar initials at 10 px (tiny) · old non-ds parts (oldSlots) · agents at 390: the five tabs wrap onto 2 lines (`stripLines: 2`; 5035 «no hidden tab» keeps the wrap — «채용» stands alone on line 2) · the agents rows' name links are pressed 20 px high at 390 (`small: ['… h20']`): ListRow's title slot is `truncate` (overflow hidden), so a link widened by padding / a negative margin is clipped (codex 6062 MEDIUM 1, reproduced) and a stretched `::after` needs ds changes (a trailing box above it) — not fixed in this PR, PO's call · the agents rows' checkbox (an admin's row of a desktop runtime) is a 24 px wide press (`small: ['SPAN w24']` — found when the fixture got a desktop-runtime agent; not fixed here, reported) · (the agents list's description no longer breaks INSIDE a word («관 / 리해요») since 6058's PageHead — `descMidBreak` is a guard now: a mid-word break goes RED, no BASELINE entry).
 * Names `states-{place}-{state}-{width}.png` → CAPTURE_OUT when set, else this test's output folder.
 */
import { appendFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { expect, test, type Page } from '@playwright/test';
import type { Plugin } from 'esbuild';
import { compile, optimize } from '@tailwindcss/node';
import { layoutStubPlugin, STUBS } from './support/layout-stubs';
import { pressKey } from './support/press-key';
import { tailwindCandidates } from './support/tailwind-candidates';
import { shellClasses, shot } from './support/shell-scene';

const req = createRequire(__filename);
const WEB = path.join(__dirname, '..');
const SRC = path.join(WEB, 'src');
const APP = path.join(SRC, 'app');

type PlaceId = 'home' | 'chats' | 'agents' | 'settings';
type StateId = 'default' | 'loading' | 'empty' | 'error' | 'long' | 'partial';
const PLACES: Array<{ id: PlaceId; path: string; label: string }> = [
  { id: 'home', path: '/org-briefing', label: '홈' },
  { id: 'chats', path: '/chats', label: '채팅' },
  { id: 'agents', path: '/organization/workforce', label: '에이전트' },
  { id: 'settings', path: '/settings', label: '설정' },
];
const STATES: StateId[] = ['default', 'loading', 'empty', 'error', 'long'];
/** states only ONE place has: the home's «partial» = the model is there (today's read answered) and a side read failed (notifications) → the list stays and the notice «일부만 불러왔어요 + [다시 시도]» stands over it (org-briefing-shell `home-incomplete-notice`) */
const EXTRA_STATES: Partial<Record<PlaceId, StateId[]>> = { home: ['partial'] };
const WIDTHS = [1440, 390] as const;

// ── the bundle ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// the router answers the stubs cannot: the address the harness sets (window.__pathname · window.__search)
const ROUTER_STUB = `
  export function usePathname() { return window.__pathname || '/org-briefing'; }
  export function useRouter() { return { push() {}, replace() {}, back() {}, refresh() {}, prefetch() {} }; }
  export function useSearchParams() { return new URLSearchParams(window.__search || ''); }
  export function useParams() { return {}; }
  export function redirect() {} export function notFound() {}`;
const NO_SSE = {
  '@/hooks/use-chat-sse': 'export function useChatSse() { return { connected: true, polling: false }; } export const isOwnMessage = () => false; export function newClientNonce() { return "n"; } export function normalizeToMessage(m) { return m; } export function sentMessageFromAnswer(m) { return m; }',
  '@/hooks/use-auto-refresh': 'export function useAutoRefresh() {}',
  '@/hooks/use-chat-message-deleted-sse': 'export function useChatMessageDeletedSse() {}',
  '@/components/realtime-provider': 'export function useSseMultiplexerContext() { return null; } export function RealtimeProvider({ children }) { return children; }',
};
function scenePlugin(): Plugin {
  const dash = STUBS['@/app/dashboard/dashboard-shell']!;
  return {
    name: 'states-5031',
    setup(b) {
      b.onResolve({ filter: /^next\/navigation$/ }, (a) => ({ path: a.path, namespace: 'st-router' }));
      b.onLoad({ filter: /.*/, namespace: 'st-router' }, () => ({ contents: ROUTER_STUB, loader: 'js', resolveDir: WEB }));
      // the route files import the dashboard context RELATIVELY (`../../dashboard/dashboard-shell`): the same small stub as `@/app/dashboard/dashboard-shell`
      b.onResolve({ filter: /dashboard\/dashboard-shell$/ }, (a) => ({ path: a.path, namespace: 'st-dash' }));
      b.onLoad({ filter: /.*/, namespace: 'st-dash' }, () => ({ contents: dash, loader: 'js', resolveDir: WEB }));
      // the chats route's own two modules (the layout's rail context · the no-project rule) are imported by ChatListView as `@/app/…`: the REAL files, not the generated stubs, or the rail and the outlet would not share one context
      b.onResolve({ filter: /^@\/app\/\(authenticated\)\/chats\/(chat-rail-context|no-project)$/ }, (a) => ({ path: path.join(APP, '(authenticated)', 'chats', `${a.path.split('/').pop()}${a.path.endsWith('chat-rail-context') ? '.tsx' : '.ts'}`) }));
      b.onResolve({ filter: new RegExp(`^(${Object.keys(NO_SSE).map((k) => k.replace(/[/.-]/g, '\\$&')).join('|')})$`) }, (a) => ({ path: a.path, namespace: 'st-nosse' }));
      b.onLoad({ filter: /.*/, namespace: 'st-nosse' }, (a) => ({ contents: NO_SSE[a.path as keyof typeof NO_SSE], loader: 'js', resolveDir: WEB }));
    },
  };
}

let built: { js: string; css: string } | null = null;
async function build() {
  if (built) return built;
  const esbuild = req('esbuild') as typeof import('esbuild');
  const out = await esbuild.build({
    stdin: {
      contents: `
        import React from 'react'; import { createRoot } from 'react-dom/client'; import { NextIntlClientProvider } from 'next-intl';
        import ko from './messages/ko.json';
        import { TopBar } from './src/components/nav/top-bar';
        import { TopBarProvider } from './src/components/nav/top-bar-context';
        import { NavRail } from './src/components/nav/nav-rail';
        import { MobileTabBar } from './src/components/nav/mobile-tab-bar';
        import { SidebarProvider } from './src/components/ui/sidebar';
        import { ToastProvider } from './src/components/ui/toast';
        import { TeamPresenceToggleProvider } from './src/components/presence/team-presence-toggle';
        import { CommandPaletteProvider } from './src/components/command-palette/command-palette-context';
        import { HomeModelProvider, useHomeModel } from './src/components/home/home-model-provider';
        import { OrgBriefingShell } from './src/components/org-briefing/org-briefing-shell';
        import ChatsLayout from './src/app/(authenticated)/chats/layout';
        import ChatsPage from './src/app/(authenticated)/chats/page';
        import { WorkforceFrame } from './src/components/agents/workforce-frame';
        import { AgentsPageTabs } from './src/components/agents/agents-page-tabs';
        import SettingsPage from './src/app/(authenticated)/settings/page';
        const h = React.createElement;
        // the shell's own wiring of the icon rail's «홈» number (dashboard-shell.tsx NavRailWithHomeBadge): the home model's one number
        function RailWithBadge(props) { const { model, partial } = useHomeModel(); return h(NavRail, { ...props, todayCount: model?.badge ?? 0, todayCountAtLeast: partial }); }
        const Frame = ({ cfg, children }) => (
          <SidebarProvider className="h-svh dashboard-shell-root" open={cfg.listOpen}>
            <RailWithBadge account={{ orgId: 'org-1', orgMemberships: cfg.ctx.orgMemberships, projectId: 'p1', projectMemberships: cfg.ctx.projectMemberships, userName: '송윤재' }} listColumn={{ open: cfg.listOpen, onToggle() {} }} chatUnreadTotal={cfg.chatUnread} onOpenPalette={() => {}} />
            {/* the list column: its REAL width (the gap the shell reserves + the 256 column itself), EMPTY — AppSidebar's content is NOT drawn here (see the file's header). The settings screen has its own navigation: the shell folds the column there (width 0), as the shell does (5c) */}
            <div className={cfg.shell.peer} data-state={cfg.listOpen ? 'expanded' : 'collapsed'} data-collapsible={cfg.listOpen ? '' : 'offcanvas'} data-variant="inset" data-side="left" id="peer"><div data-slot="sidebar-gap" className={cfg.shell.gap} id="peer-gap" />
              {cfg.listOpen ? <div id="list-column-placeholder" className="fixed inset-y-0 left-14 z-10 hidden w-(--sidebar-width) border-r border-ds-line bg-ds-surface lg:block" aria-hidden="true" /> : null}</div>
            <main id="inset" className={cfg.shell.inset}>
              <div id="scroller" className={cfg.shell.scroller}>
                <TeamPresenceToggleProvider value={{ toggle() {}, workingCount: 0, open: false }}>
                  <TopBar orgId="org-1" orgMemberships={cfg.ctx.orgMemberships} projectId="p1" projectMemberships={cfg.ctx.projectMemberships} userName="송윤재" />
                </TeamPresenceToggleProvider>
                <div className={cfg.shell.grid}><div id="cell" className={cfg.shell.content}>{children}</div></div>
              </div>
              <MobileTabBar chatUnreadTotal={cfg.chatUnread} />
            </main>
          </SidebarProvider>);
        const bodies = {
          home: () => <OrgBriefingShell />,
          chats: () => <ChatsLayout><ChatsPage /></ChatsLayout>,
          agents: () => <WorkforceFrame><AgentsPageTabs /></WorkforceFrame>,
          settings: () => <SettingsPage />,
        };
        window.__mount = (cfg) => {
          window.__pathname = cfg.pathname; window.__search = cfg.search || ''; window.__dashboardCtx = cfg.ctx;
          const Body = bodies[cfg.place];
          createRoot(document.getElementById('root')).render(
            <NextIntlClientProvider locale="ko" messages={ko} timeZone="Asia/Seoul">
              <ToastProvider><CommandPaletteProvider><HomeModelProvider viewerMemberId="me-1" projectId="p1" orgId="org-1"><TopBarProvider pathname={cfg.pathname}>
                <Frame cfg={cfg}><Body /></Frame>
              </TopBarProvider></HomeModelProvider></CommandPaletteProvider></ToastProvider>
            </NextIntlClientProvider>);
        };`,
      resolveDir: WEB, loader: 'tsx',
    },
    bundle: true, format: 'iife', platform: 'browser', write: false, logLevel: 'silent', jsx: 'automatic',
    tsconfig: path.join(WEB, 'tsconfig.json'),
    define: { 'process.env': JSON.stringify({ NODE_ENV: 'production', NEXT_PUBLIC_APP_URL: 'https://app.sprintable.ai', NEXT_PUBLIC_EE_ENABLED: 'false' }) }, // the settings page reads more of them (a bare `process.env`)
    plugins: [scenePlugin(), layoutStubPlugin()],
  });
  const js = out.outputFiles[0]!.text;
  // the class strings read from the sources are not in the bundle: hand them to the real Tailwind scan
  const extra = Object.values(shellClasses()).join(' ').split(/\s+/).filter(Boolean);
  const compiler = await compile(readFileSync(path.join(APP, 'globals.css'), 'utf8'), { base: APP, onDependency: () => {} });
  const css = (optimize as unknown as (c: string, o?: object) => { code: string })(compiler.build([...tailwindCandidates(js), ...extra]), { minify: false }).code;
  built = { js, css };
  return built;
}
// the first scene used to pay for the bundle + the Tailwind build inside its own 30 s: build once, up front, with its own room
test.beforeAll(async () => { test.setTimeout(180_000); await build(); });

// ── the server's answers ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
/** an answer; `__delay` holds it (ms) — the «loading» state is the page waiting on it */
type Answer = unknown | { __status: number; body: unknown; __delay?: number };
const ok = (body: unknown, extra: { __delay?: number } = {}) => ({ __status: 200, body, ...extra });
const fail = (status = 500, extra: { __delay?: number } = {}) => ({ __status: status, body: {}, ...extra });
const HOLD = 60_000; // «held for good»: the scene is shot while the page is waiting

const LONG_KO = '가'.repeat(40);
const LONG_EN = 'Abcdefghij'.repeat(6) + 'Klmnop'; // 66 letters
const LONG_TITLE = '결제수단을바꾸는일'.repeat(9);
const LONG_TITLE_EN = 'ReallyLongWorkItemTitleWithoutAnySpaces'.repeat(2);
const LONG_AGENT = 'a-very-long-agent-name-that-keeps-going-and-going-without-a-single-space-to-break-on-0123456789-abcdefghijklmnopqrstuvwxyz';
const LONG_PROJECT = '아주아주아주아주아주아주아주아주긴프로젝트이름'.repeat(3);

const need = (over: Record<string, unknown>) => ({
  source: 'gate', source_id: 'g1', kind: 'approval', risk: 'low', work_item: { id: 's1', type: 'story', title: '결제 연동 검수' }, requested_by: { name: '민' },
  reason: '결제수단을 바꾸는 일이라 사람이 확인해야 해요', created_at: '2026-11-27T09:00:00Z', conversation_id: 'c1', conversation_project_id: null, recipe_publish: false, project_id: null, ...over,
});
const today = (needs: unknown[], runs: unknown[] = []) => ({ data: { needs_me: needs, needs_me_count: needs.length, agent_progress: runs, completed_today: [], published_today: { count: 0, by_channel: [] }, usage: { platform: [] } } });
const run = (id: string, agent: string, title: string) => ({ run_id: id, agent: { name: agent }, work_item: { title }, status: 'running', started_at: '2026-11-27T10:30:00Z', cancel: null });
const room = (id: string, title: string, over: Record<string, unknown> = {}) => ({ id, type: 'group', title, latest_message: null, updated_at: '2026-11-27T01:00:00Z', unread_count: 0, project_id: 'p1', project_name: '스프린터블', ...over });
const ROOMS = [room('r1', '런칭 준비'), room('r2', '디자인 리뷰', { unread_count: 3 }), room('r3', '주간 회고'), room('r4', '결제 연동'), room('r5', '민 · 개발 에이전트', { type: 'dm' })];
const agent = (id: string, name: string, over: Record<string, unknown> = {}) => ({ id, name, role: 'engineer', is_active: true, verified: true, type: 'agent', ...over });
const AGENTS = [agent('a1', '댄 어윈', { client_version: '2.1.0', runtime_type: 'claude-code' }), agent('a2', '민'), agent('a3', '리뷰 에이전트', { is_active: false, verified: false }), agent('a4', '문서 에이전트')];
const ME = { data: { id: 'me-1', user_id: 'u-1', name: '송윤재', email: 'yoonjae@example.com', role: 'owner', org_id: 'org-1', type: 'human' } };

/** the answers every scene has; a scene overrides what it is about */
const BASE: Record<string, Answer> = {
  'GET /api/today': today([]),
  'GET /api/notifications': { data: [] },
  'GET /api/agents/desktop-sessions': { data: [] },
  'GET /api/stories': { data: [] },
  'GET /api/members': { data: [] },
  'GET /api/conversations': { data: [], total: 0 },
  'GET /api/conversations/recent-outside-project': { data: [] },
  'GET /api/team-members': { data: [] },
  'GET /api/projects': { data: [{ id: 'p1', name: '스프린터블' }] },
  'GET /api/me': ME,
  'GET /api/user-blocks': [], // a bare array (the section reads nothing else)
  'GET /api/activation/checklist': { data: { steps: { signed_up: true, email_verified: true, org_created: true, agent_connected: true, first_roundtrip: true }, completed: 5, total: 5, all_complete: true, first_instruction_conversation_id: null } },
  'GET /api/organizations': { data: [{ id: 'org-1', name: '올리베이라', slug: 'acme' }] },
};
function answers(place: PlaceId, state: StateId): Record<string, Answer> {
  const a: Record<string, Answer> = {};
  if (place === 'home') {
    const rows = [need({}), need({ source_id: 'g2', kind: 'signature', risk: 'high', work_item: { id: 's2', type: 'story', title: '외부 발송 승인' }, requested_by: { name: '리뷰 에이전트' }, created_at: '2026-11-27T10:00:00Z' })];
    const runs = [run('r1', '댄 어윈', '로그인 개선')];
    if (state === 'default') a['GET /api/today'] = today(rows, runs);
    if (state === 'loading') a['GET /api/today'] = ok(today(rows, runs), { __delay: HOLD });
    if (state === 'empty') a['GET /api/today'] = today([]);
    if (state === 'error') a['GET /api/today'] = fail();
    if (state === 'partial') { a['GET /api/today'] = today(rows, runs); a['GET /api/notifications'] = fail(); }
    if (state === 'long') a['GET /api/today'] = today(
      [need({ work_item: { id: 's1', type: 'story', title: LONG_TITLE }, requested_by: { name: LONG_KO }, reason: LONG_TITLE_EN }), need({ source_id: 'g2', kind: 'signature', risk: 'high', work_item: { id: 's2', type: 'story', title: LONG_TITLE_EN }, requested_by: { name: LONG_EN }, reason: LONG_TITLE, created_at: '2026-11-27T10:00:00Z' })],
      [run('r1', LONG_EN, LONG_TITLE)]);
  }
  if (place === 'chats') {
    if (state === 'default') a['GET /api/conversations'] = { data: ROOMS, total: ROOMS.length };
    if (state === 'loading') a['GET /api/conversations'] = ok({ data: ROOMS, total: ROOMS.length }, { __delay: HOLD });
    if (state === 'error') a['GET /api/conversations'] = fail();
    if (state === 'long') a['GET /api/conversations'] = { data: [room('r1', LONG_TITLE), room('r2', LONG_EN, { unread_count: 12 }), room('r3', LONG_KO), ...ROOMS.slice(0, 2)], total: 5 };
  }
  if (place === 'agents') {
    if (state === 'default') a['GET /api/team-members'] = { data: AGENTS };
    if (state === 'loading') a['GET /api/team-members'] = ok({ data: AGENTS }, { __delay: HOLD });
    if (state === 'error') a['GET /api/team-members'] = fail();
    if (state === 'long') a['GET /api/team-members'] = { data: [agent('l1', LONG_AGENT, { device_name: 'a-computer-with-a-rather-long-device-name-too' }), agent('l2', LONG_KO), ...AGENTS.slice(0, 2)] };
  }
  if (place === 'settings') {
    if (state === 'loading') a['GET /api/me'] = ok(ME, { __delay: HOLD });
    if (state === 'error') a['GET /api/me'] = fail();
    if (state === 'empty') a['GET /api/projects'] = { data: [] };
    if (state === 'long') a['GET /api/projects'] = { data: [{ id: 'p1', name: LONG_PROJECT }, { id: 'p2', name: LONG_KO }, { id: 'p3', name: LONG_EN }] };
  }
  return a;
}
/** which settings tab a state shows (see the header) */
const settingsSearch = (state: StateId, phone: boolean) => (state === 'empty' || state === 'long' ? 'tab=projects' : phone && state === 'default' ? '' : 'tab=profile'); // a phone's default is the LIST (the nav column is the screen); the other states are a pane

// ── the scene ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const CTX = {
  orgId: 'org-1', currentTeamMemberId: 'me-1', projectId: 'p1', projectName: '스프린터블', role: 'owner', currentMemberType: 'human', userName: '송윤재',
  orgMemberships: [{ orgId: 'org-1', orgName: '올리베이라', orgSlug: 'acme', role: 'owner' }],
  projectMemberships: [{ projectId: 'p1', projectName: '스프린터블', projectSlug: 'sprintable', orgId: 'org-1' }],
};
/**
 * «the scene has settled» = the fonts are IN (none failed) and the geometry of the screen is the same on two reads in a row (the entrance of the lists · the first paint) — bounded polling, no fixed wait (a fixed 400 ms was a guess at «long enough»).
 * The signature is the rounded boxes of every press · heading and the scroller's height; two equal reads are the pass count, the 8 s is only the safety stop.
 */
async function settle(page: Page) {
  await page.evaluate(() => document.fonts.ready);
  const failed = await page.evaluate(() => [...document.fonts].filter((f) => f.status === 'error').map((f) => `${f.family} ${f.unicodeRange.slice(0, 24)}`));
  expect(failed, 'a product font failed to load (the measures would come from the fallback font)').toEqual([]);
  let prev = '';
  await expect.poll(async () => {
    const sig = await page.evaluate(() => [...document.querySelectorAll('button, a[href], input, h1, [data-testid]')].map((e) => { const r = e.getBoundingClientRect(); return `${Math.round(r.left)},${Math.round(r.top)},${Math.round(r.width)},${Math.round(r.height)}`; }).join('|') + `#${document.getElementById('scroller')?.scrollHeight}`);
    const same = sig === prev; prev = sig; return same;
  }, { message: 'the scene never held still', timeout: 8000, intervals: [100, 100, 200, 300] }).toBe(true);
}

async function open(page: Page, place: PlaceId, state: StateId, width: number) {
  const { js, css } = await build();
  const api = { ...BASE, ...answers(place, state) };
  await page.setViewportSize({ width, height: width < 500 ? 844 : 900 });
  await page.unrouteAll();
  await page.route('http://preview.test/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/') {
      return route.fulfill({ contentType: 'text/html', body: `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head><body class="bg-background text-foreground"><div id="root"></div></body></html>` });
    }
    // the product's own font files (globals.css `@font-face` → /fonts/*.woff2) are SERVED, not answered by the catch-all below (it handed back JSON, so the faces settled as FAILED and every width came from the fallback font — a measure that would differ between a Mac and a Linux runner; codex 6062 round 1, MEDIUM 2)
    if (url.pathname.startsWith('/fonts/')) return route.fulfill({ path: path.join(WEB, 'public', 'fonts', path.basename(url.pathname)), contentType: 'font/woff2', headers: { 'access-control-allow-origin': '*' } });
    const hit = api[`${route.request().method()} ${url.pathname}`] ?? api[url.pathname];
    if (hit === undefined) return route.fulfill({ status: 200, contentType: 'application/json', body: '{"data":[]}' });
    const { __status, body, __delay } = (hit && typeof hit === 'object' && '__status' in (hit as object) ? hit : { __status: 200, body: hit }) as { __status: number; body: unknown; __delay?: number };
    if (__delay) await new Promise((r) => setTimeout(r, __delay));
    return route.fulfill({ status: __status, contentType: 'application/json', body: JSON.stringify(body) });
  });
  const errs: string[] = [];
  page.on('pageerror', (e) => errs.push(String(e).slice(0, 300)));
  await page.goto('about:blank');
  await page.goto('http://preview.test/');
  await page.addScriptTag({ content: js });
  if (!(await page.evaluate(() => typeof (window as unknown as { __mount?: unknown }).__mount === 'function'))) throw new Error(`the bundle did not start: ${errs.join(' | ') || 'no page error'}`);
  const p = PLACES.find((x) => x.id === place)!;
  const cfg = { place, pathname: p.path, search: place === 'settings' ? settingsSearch(state, width < 500) : '', ctx: CTX, chatUnread: 0, listOpen: place !== 'settings', shell: shellClasses() };
  await page.evaluate((c) => (window as unknown as { __mount: (c: unknown) => void }).__mount(c), cfg);
  await page.waitForSelector('[data-testid="top-bar"]', { state: 'attached', timeout: 8000 }).catch((e) => { throw new Error(`the bar did not draw (page errors: ${errs.join(' | ') || 'none'})`, { cause: e }); });
  await page.evaluate(() => document.fonts.ready);
  return { errs };
}

// ── the measures ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const measure = (page: Page) => page.evaluate((keySrc) => {
  const pressKey = new Function(`return (${keySrc})`)() as (label: string, w: number, h: number) => string;
  const shown = (e: Element) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== 'hidden' && !e.closest('[aria-hidden="true"]') && (e as HTMLElement & { checkVisibility?: () => boolean }).checkVisibility?.() !== false; };
  const label = (e: Element) => ((e.getAttribute('data-testid') || e.getAttribute('aria-label') || e.textContent || e.tagName) as string).trim().replace(/\s+/g, ' ').slice(0, 28);
  // a disabled control is not pressed by a finger (it does nothing, and a disabled button answers hit tests as what is under it): it is left out of the whole press check — size · corners · covered — the same way (codex 6062 round 2, MEDIUM 3)
  const isDisabled = (e: Element) => (e as HTMLButtonElement).disabled === true || e.getAttribute('aria-disabled') === 'true' || !!e.closest('[aria-disabled="true"], fieldset:disabled');
  const presses = [...document.querySelectorAll('button, a[href], input, select, summary, textarea, [role="checkbox"], [role="switch"]')].filter(shown).filter((e) => !isDisabled(e));
  // PRESSABLE, not drawn: what a finger reaches is where `elementFromPoint` answers the press itself (or something in it) — a box widened by padding / a negative margin that an ancestor's overflow clips (a `truncate` parent) is still 44 by getBoundingClientRect and is NOT pressable there (codex 6062 round 1, MEDIUM 1).
  // So the press' size is the run of points around its centre that hit it (1 px steps; a `::after` that widens the press counts, a clipped box does not); the four inner corners + the centre of its drawn box must hit it too.
  const hits = (e: Element, x: number, y: number) => { const h = document.elementFromPoint(x, y); return !!h && (e === h || e.contains(h) || (h.closest('label')?.contains(e) ?? false)); };
  const reach = (e: Element) => {
    const r = e.getBoundingClientRect(); const cx = r.left + r.width / 2; const cy = r.top + r.height / 2;
    if (cx < 0 || cy < 0 || cx >= innerWidth || cy >= innerHeight || !hits(e, cx, cy)) return { w: r.width, h: r.height, covered: true };
    let t = cy, b = cy, l = cx, rt = cx;
    for (let i = 0; i < 300 && t - 1 >= 0 && hits(e, cx, t - 1); i++) t--;
    for (let i = 0; i < 300 && b + 1 < innerHeight && hits(e, cx, b + 1); i++) b++;
    for (let i = 0; i < 300 && l - 1 >= 0 && hits(e, l - 1, cy); i++) l--;
    for (let i = 0; i < 300 && rt + 1 < innerWidth && hits(e, rt + 1, cy); i++) rt++;
    return { w: rt - l + 1, h: b - t + 1, covered: false };
  };
  // each press is brought to the middle of the view first (a row half behind the sticky instruction strip / the tab bar, or one far down a long list, is not «unreachable»: it is scrolled) — only by the scroll boxes a PERSON can scroll
  // (`overflow-y: auto | scroll`: the shell's `#scroller`, a list's own box), never by `scrollIntoView()`: that also scrolls `overflow:hidden` boxes (a `truncate` slot), which would bring a CLIPPED press into reach and make it look pressable
  // (codex 6062 round 2, MEDIUM 1). What was scrolled is put back, and every element's scroll position is compared before / after the measure (`scrollDrift`).
  const scrollOf = () => { const m = new Map<Element, string>(); for (const el of document.querySelectorAll('*')) if (el.scrollTop || el.scrollLeft) m.set(el, `${el.scrollTop},${el.scrollLeft}`); return m; };
  const scrollBefore = scrollOf();
  const scrolled = new Map<Element, number>();
  const bringIntoView = (e: Element) => {
    for (let a = e.parentElement; a; a = a.parentElement) {
      const oy = getComputedStyle(a).overflowY;
      if ((oy === 'auto' || oy === 'scroll') && a.scrollHeight > a.clientHeight) {
        if (!scrolled.has(a)) scrolled.set(a, a.scrollTop);
        const ar = a.getBoundingClientRect(); const er = e.getBoundingClientRect();
        a.scrollTop += (er.top + er.height / 2) - (ar.top + ar.height / 2);
      }
    }
  };
  const reached = presses.map((e) => {
    const r0 = e.getBoundingClientRect();
    bringIntoView(e);
    const x = reach(e);
    const r = e.getBoundingClientRect();
    // the corners are asked 3 px inside the box, or further in where the box is rounded (a point in the cut-off corner of a pill is not the press): 30 % of the LARGEST of the four radii (a % radius is of the shorter side), at most just short of half the shorter side
    const cs = getComputedStyle(e);
    const radius = Math.max(...[cs.borderTopLeftRadius, cs.borderTopRightRadius, cs.borderBottomRightRadius, cs.borderBottomLeftRadius].map((v) => (v.endsWith('%') ? (parseFloat(v) / 100) * Math.min(r.width, r.height) : parseFloat(v)) || 0));
    const inset = Math.min(Math.max(3, radius * 0.3 + 1), Math.max(1, Math.min(r.width, r.height) / 2 - 1));
    const pts: [string, number, number][] = [['top-left', r.left + inset, r.top + inset], ['top-right', r.right - inset, r.top + inset], ['bottom-left', r.left + inset, r.bottom - inset], ['bottom-right', r.right - inset, r.bottom - inset], ['centre', r.left + r.width / 2, r.top + r.height / 2]];
    // only a press that CLAIMS ≥ 44 by its drawn box is asked (a smaller one is `small` already); a point outside the viewport is not asked
    const missed = x.covered || r.width < 43.5 || r.height < 43.5 ? [] : pts.filter(([, px, py]) => px >= 0 && py >= 0 && px < innerWidth && py < innerHeight && !hits(e, px, py)).map(([n]) => `${label(e)} ${n}`);
    return { e, ...x, missed, r0: { x: r0.left, y: r0.top, w: r0.width, h: r0.height } };
  });
  for (const [el, top] of scrolled) el.scrollTop = top; // put every scroll box back
  // nothing but what it was: every element's scroll position after the measure is the one before it
  const scrollAfter = scrollOf();
  const scrollDrift = [...new Set([...scrollBefore.keys(), ...scrollAfter.keys()])].filter((el) => (scrollBefore.get(el) ?? '0,0') !== (scrollAfter.get(el) ?? '0,0')).map((el) => `${(el.id && `#${el.id}`) || el.getAttribute('data-testid') || el.tagName} ${scrollBefore.get(el) ?? '0,0'} -> ${scrollAfter.get(el) ?? '0,0'}`);
  const small = reached.filter((x) => x.w < 43.5 || x.h < 43.5).map((x) => pressKey(label(x.e), x.w, x.h)); // only the side under 44 is in the key (a text's width differs Mac ↔ Linux)
  // a press whose own centre answers as something else is not reachable either
  const unreached = reached.flatMap((x) => (x.covered ? [`${label(x.e)} centre (covered by something else)`] : x.missed));
  const covered = reached.filter((x) => x.covered).map((x) => label(x.e));
  // the presses whose reach is not what their box says — drawn on the evidence picture of a red scene (assertScene)
  const trouble = reached.filter((x) => x.w < 43.5 || x.h < 43.5 || x.missed.length > 0 || x.covered).map((x) => ({ label: label(x.e), ...x.r0, reachH: Math.round(x.h) }));
  const leaves = [...document.querySelectorAll('body *')].filter((e) => e.children.length === 0 && (e.textContent || '').trim() && shown(e) && !e.closest('[data-slot="ds-chip"]'));
  const tiny = leaves.filter((e) => parseFloat(getComputedStyle(e).fontSize) < 12).map((e) => `${(e.textContent || '').trim().slice(0, 20)} ${getComputedStyle(e).fontSize}`);
  const ALLOWED = ['textarea', 'sidebar-wrapper', 'sidebar-inset', 'sidebar-gap', 'sidebar-container', 'sidebar', 'tabs', 'tabs-list', 'tabs-trigger', 'tabs-content'];
  // old (non-ds) parts by name AND how many of each are drawn («card×3»): a new instance of an old part is a new finding too, not only a new kind (codex 6062 round 1, LOW)
  const oldIn = (roots: (Element | null)[]) => {
    const count = new Map<string, number>();
    for (const e of roots.flatMap((root) => [...(root?.querySelectorAll('[data-slot]') ?? [])])) { const n = e.getAttribute('data-slot')!; if (!n.startsWith('ds-') && !ALLOWED.includes(n)) count.set(n, (count.get(n) ?? 0) + 1); }
    return [...count].map(([n, c]) => `${n}×${c}`).sort();
  };
  const oldSlots = oldIn([document.getElementById('cell')]);
  const chromeOldSlots = oldIn(['[data-testid="top-bar"]', '[data-testid="nav-rail"]', '[data-testid="mobile-tab-bar"]'].map((q) => document.querySelector(q)));
  const scroller = document.getElementById('scroller')!;
  const lit = [...document.querySelectorAll('[data-testid="nav-rail"] [aria-current="page"], [data-testid="mobile-tab-bar"] [aria-current="page"]')].filter(shown).map((e) => (e.getAttribute('aria-label') || e.textContent || '').trim().replace(/\s+/g, ' '));
  const h1 = [...document.querySelectorAll('h1')].filter(shown).map((e) => (e.textContent || '').trim().slice(0, 30));
  // the page's title said TWICE: a heading of the body whose words are also a visible word of the top bar (its path: «올리베이라 › 홈»)
  const barWords = [...document.querySelectorAll('[data-testid="top-bar"] *')].filter((e) => e.children.length === 0 && shown(e) && !e.closest('h1')).map((e) => (e.textContent || '').trim());
  // «drawn» = takes room (a screen-reader-only h1 is a 1 px box: it is still THE h1, but it does not say the title a second time on the screen)
  const drawnH1 = [...document.querySelectorAll('h1')].filter((e) => { const r = e.getBoundingClientRect(); return shown(e) && r.width > 2 && r.height > 2; }).map((e) => (e.textContent || '').trim().slice(0, 30));
  const dupTitle = drawnH1.some((t) => t !== '' && barWords.includes(t));
  // the agents' «전체 보기» strip: how many LINES its five links stand on (the rule: one) · the list's description: does a line break fall INSIDE a word («관 / 리해요»)
  const stripLinks = [...document.querySelectorAll('[data-testid="workforce-all-views-menu"] [data-all-view]')].filter(shown);
  const stripLines = new Set(stripLinks.map((e) => Math.round(e.getBoundingClientRect().top))).size;
  const desc = [...document.querySelectorAll('#cell p, #cell div')].find((e) => e.children.length === 0 && (e.textContent || '').startsWith('조직 내 전체 프로젝트의'));
  let descMidBreak = false;
  const textNode = desc?.firstChild;
  // the word-break check only means something when it LOOKED: the description is there and is a text node (otherwise a missing / reshaped description would pass in silence — codex 6062 round 2, LOW)
  const descChecked = !!desc && !!textNode && textNode.nodeType === 3;
  if (textNode && textNode.nodeType === 3) {
    const text = textNode.textContent || '';
    let prevTop: number | null = null;
    for (let i = 0; i < text.length; i++) {
      const r = document.createRange(); r.setStart(textNode, i); r.setEnd(textNode, i + 1);
      const rect = r.getClientRects()[0];
      if (!rect) continue;
      const top = Math.round(rect.top);
      if (prevTop !== null && top > prevTop + 2 && i > 0 && !/\s/.test(text[i - 1]!) && !/\s/.test(text[i]!)) descMidBreak = true;
      prevTop = top;
    }
  }
  return {
    h1, lit, dupTitle, stripLines, descMidBreak,
    overflowX: document.documentElement.scrollWidth > innerWidth + 1,
    scrollerOverflowX: scroller.scrollWidth > scroller.clientWidth + 1,
    small, unreached, covered, trouble, scrollDrift, descChecked, tiny, oldSlots, chromeOldSlots,
  };
}, pressKey.toString());

type Finding = { h1?: number; dupTitle?: true; stripLines?: number; descMidBreak?: true; small?: string[]; unreached?: string[]; tiny?: string[]; oldSlots?: string[] };
/**
 * What the real screens do TODAY, exactly, per scene (a scene with no entry is clean): the scene is red if a listed finding is gone (a fix landed → shrink the list) or a new one shows — nothing is loosened silently.
 * `h1` is the number of visible h1 where it is not 1 · `dupTitle` the body title that the bar's path already says · `small` (phone only) presses under 44 — keyed by the side that is under 44 only (`h20` · `w24` · `24x20`, see support/press-key.ts: a text's width differs Mac ↔ Linux) · `tiny` text under 12 px · `oldSlots` non-ds parts in the BODY.
 * Written from a collect run (STATES_COLLECT=<file> makes every scene write what it measured instead of asserting); every line is a finding in the report.
 */
// <BASELINE-BEGIN>
const BASELINE: Record<string, Finding> = {
  'home-default-1440': { tiny: ['민 10px', '리 10px'], oldSlots: ['card×1', 'tooltip-trigger×3'] },
  'home-loading-1440': { oldSlots: ['card×2'] },
  'home-empty-1440': { oldSlots: ['card×1'] },
  'home-error-1440': { oldSlots: ['button×1'] },
  'home-long-1440': { tiny: ['가 10px', 'AB 10px'], oldSlots: ['card×1', 'tooltip-trigger×3'] },
  'home-partial-1440': { tiny: ['민 10px', '리 10px'], oldSlots: ['button×1', 'card×1', 'tooltip-trigger×3'] },
  'chats-default-1440': { oldSlots: ['button×5', 'popover-trigger×1'] },
  'chats-loading-1440': { oldSlots: ['popover-trigger×1'] },
  'chats-empty-1440': { oldSlots: ['popover-trigger×1'] },
  'chats-error-1440': { oldSlots: ['popover-trigger×1'] },
  'chats-long-1440': { oldSlots: ['button×5', 'popover-trigger×1'] },
  'settings-default-1440': { dupTitle: true },
  'settings-loading-1440': { dupTitle: true },
  'settings-empty-1440': { dupTitle: true },
  'settings-error-1440': { dupTitle: true },
  'settings-long-1440': { dupTitle: true },
  'home-default-390': { tiny: ['민 10px', '리 10px'], oldSlots: ['card×1', 'tooltip-trigger×2'] },
  'home-loading-390': { oldSlots: ['card×2'] },
  'home-empty-390': { oldSlots: ['card×1'] },
  'home-error-390': { oldSlots: ['button×1'] },
  'home-long-390': { tiny: ['가 10px', 'AB 10px'], oldSlots: ['card×1', 'tooltip-trigger×2'] },
  'home-partial-390': { tiny: ['민 10px', '리 10px'], oldSlots: ['button×1', 'card×1', 'tooltip-trigger×2'] },
  'chats-default-390': { oldSlots: ['button×5', 'popover-trigger×1'] },
  'chats-loading-390': { oldSlots: ['popover-trigger×1'] },
  'chats-empty-390': { oldSlots: ['popover-trigger×1'] },
  'chats-error-390': { oldSlots: ['popover-trigger×1'] },
  'chats-long-390': { oldSlots: ['button×5', 'popover-trigger×1'] },
  'agents-default-390': { stripLines: 2, small: ['SPAN w24', '댄 어윈 h20', '민 h20', '리뷰 에이전트 h20', '문서 에이전트 h20'] },
  'agents-loading-390': { stripLines: 2 },
  'agents-empty-390': { stripLines: 2 },
  'agents-error-390': { stripLines: 2 },
  'agents-long-390': { stripLines: 2, small: ['a-very-long-agent-name-that- h20', '가가가가가가가가가가가가가가가가가가가가가가가가가가가가 h20', 'SPAN w24', '댄 어윈 h20', '민 h20'] },
  'settings-loading-390': { h1: 0 },
  'settings-empty-390': { h1: 0 },
  'settings-error-390': { h1: 0 },
  'settings-long-390': { h1: 0 },
};
// <BASELINE-END>
/** the agents scenes that have no description to check (none expected: every agents scene draws it) */
const NO_DESC = new Set<string>([]);
/** the shell's OWN chrome (top bar · icon rail · phone tab bar) draws non-ds parts too — measured once, not in every scene (the same in all of them) */
const CHROME_OLD = ['button×2', 'dropdown-menu-trigger×1', 'popover-trigger×1'];

async function assertScene(page: Page, place: PlaceId, key: string, phone: boolean) {
  const m = await measure(page);
  // STATES_COLLECT=<file>: write what the scene measured instead of asserting it — how BASELINE is filled (and re-filled after a fix)
  // (a collect run is a MEASURING run, never a verdict: with CI set in the environment AT ALL — empty or not — the variable is ignored, so an inherited one cannot turn the scenes green without asserting)
  if (process.env['STATES_COLLECT'] && process.env['CI'] === undefined) { appendFileSync(process.env['STATES_COLLECT'], `${JSON.stringify({ key, ...m })}\n`); return; }
  const base = BASELINE[key] ?? {};
  const label = PLACES.find((p) => p.id === place)!.label;
  if (phone && m.trouble.length > 0) { // a red press scene leaves a second picture: each press whose reach is not its box, outlined in red with the height a finger reaches
    await page.evaluate((ts) => { for (const t of ts) { const d = document.createElement('div'); d.setAttribute('data-evidence', ''); d.textContent = `${t.reachH}px reached`; d.style.cssText = `position:fixed;left:${t.x}px;top:${t.y}px;width:${t.w}px;height:${t.h}px;outline:2px dashed red;color:red;font:10px/1 sans-serif;z-index:99999;pointer-events:none`; document.body.appendChild(d); } }, m.trouble);
    await shot(page, page, `states-press-${key}`);
    await page.evaluate(() => document.querySelectorAll('[data-evidence]').forEach((e) => e.remove()));
  }
  expect(m.overflowX, `${key}: the page scrolls sideways`).toBe(false);
  expect(m.scrollerOverflowX, `${key}: the shell's scroller scrolls sideways`).toBe(false);
  expect(m.lit.filter((l) => l.includes(label)), `${key}: the place's icon is lit (rail from lg · tab bar below) — lit: ${m.lit.join(' | ')}`).toHaveLength(1);
  expect(m.lit, `${key}: exactly one place is lit`).toHaveLength(1);
  expect(m.h1.length, `${key}: the number of h1 (1 is the rule) — drawn: ${m.h1.join(' | ') || 'none'}`).toBe(base.h1 ?? 1);
  expect(m.dupTitle, `${key}: the title is said twice (the bar's path and the body's h1)`).toBe(base.dupTitle ?? false);
  expect(m.stripLines, `${key}: the lines the agents' «전체 보기» strip stands on (the rule: one — every link whole, none alone on a second line)`).toBe(base.stripLines ?? (place === 'agents' ? 1 : 0));
  if (place === 'agents') expect(m.descChecked, `${key}: the agents list's description was not found as a text node — the word-break check did not look (scenes without one are listed in NO_DESC)`).toBe(!NO_DESC.has(key));
  expect(m.descMidBreak, `${key}: the agents list's description breaks INSIDE a word`).toBe(base.descMidBreak ?? false);
  expect(m.scrollDrift, `${key}: the measure left a scroll position changed`).toEqual([]);
  expect(m.oldSlots, `${key}: old (non-ds) parts drawn in the body`).toEqual(base.oldSlots ?? []);
  expect(m.tiny, `${key}: text under 12 px`).toEqual(base.tiny ?? []);
  if (phone) expect(m.small, `${key}: presses whose pressable run (where the finger reaches them) is under 44 px`).toEqual(base.small ?? []);
  if (phone) expect(m.unreached, `${key}: a press whose drawn box (4 inner corners + centre) is not what a finger reaches`).toEqual(base.unreached ?? []);
}

// ── the scenes ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
/** what each state is, in the DOM, per place — the scene is the state it says it is (not just a picture) */
async function expectState(page: Page, place: PlaceId, state: StateId) {
  const t = (s: string) => page.getByText(s, { exact: false });
  const messages = JSON.parse(readFileSync(path.join(WEB, 'messages', 'ko.json'), 'utf8')) as Record<string, Record<string, string>>;
  if (place === 'home') {
    if (state === 'default' || state === 'long') await expect(page.getByTestId('home-list')).toBeVisible();
    if (state === 'loading') { await expect(page.locator('.animate-pulse').first()).toBeVisible(); await expect(page.getByTestId('home-list')).toHaveCount(0); }
    if (state === 'empty') await expect(t(messages['home']!['emptyAllTitle']!).first()).toBeVisible();
    if (state === 'error') { await expect(t(messages['orgBriefing']!['loadErrorTitle']!).first()).toBeVisible(); await expect(page.getByRole('button', { name: messages['common']!['retry']! })).toBeVisible(); }
    if (state === 'partial') { await expect(page.getByTestId('home-list')).toBeVisible(); await expect(page.getByTestId('home-incomplete-notice')).toBeVisible(); await expect(page.getByTestId('home-incomplete-notice').getByRole('button', { name: messages['common']!['retry']! })).toBeVisible(); }
  }
  if (place === 'chats') {
    if (state === 'default') await expect(t('런칭 준비').first()).toBeVisible();
    if (state === 'loading') await expect(t(messages['common']!['loading']!).first()).toBeVisible();
    if (state === 'empty') await expect(t(messages['chats']!['noConversations']!).first()).toBeVisible();
    if (state === 'error') { await expect(t(messages['chats']!['conversationsLoadFailed']!).first()).toBeVisible(); await expect(page.getByRole('button', { name: messages['common']!['retry']! }), 'ONE retry press for one failure (a button)').toHaveCount(1);
      // the ds Button (md · secondary) gives the phone's 44 by itself (touch floor) — nothing added at the call site; the height is MEASURED here, and printed
      const box = await page.getByRole('button', { name: messages['common']!['retry']! }).boundingBox();
      console.log(`[5031] chats retry (ds Button md secondary) ${Math.round(box!.width)}x${Math.round(box!.height)} @ viewport ${page.viewportSize()!.width}`);
      if (page.viewportSize()!.width < 768) expect(box!.height, 'the phone press is >= 44').toBeGreaterThanOrEqual(44);
    }
    if (state === 'long') await expect(t(LONG_TITLE.slice(0, 12)).first()).toBeVisible();
  }
  if (place === 'agents') {
    if (state === 'default') await expect(t('댄 어윈').first()).toBeVisible();
    if (state === 'loading') await expect(page.getByTestId('agent-list-loading')).toBeVisible();
    if (state === 'empty') await expect(t(messages['settings']!['noOrgAgents']!).first()).toBeVisible();
    if (state === 'error') await expect(page.getByRole('button', { name: messages['common']!['retry']! }).first()).toBeVisible();
    if (state === 'long') await expect(t(LONG_AGENT.slice(0, 20)).first()).toBeVisible();
  }
  if (place === 'settings') {
    const phone = (page.viewportSize()?.width ?? 1440) < 500;
    if (phone && state === 'default') { await expect(page.getByTestId('settings-nav-column')).toBeVisible(); return; } // a phone's first screen: the list
    if (phone) await expect(page.getByTestId('settings-nav-column')).toBeHidden(); else await expect(page.getByTestId('settings-nav-column')).toBeVisible();
    if (state === 'default') await expect(page.getByTestId('settings-pane')).toBeVisible();
    if (state === 'loading') await expect(page.getByTestId('settings-pane').getByText(messages['common']!['loading']!).first()).toBeVisible();
    if (state === 'error') await expect(page.getByRole('button', { name: messages['common']!['retry']! }).first()).toBeVisible();
    if (state === 'empty') await expect(t(messages['settings']!['projectListEmpty']!).first()).toBeVisible();
    if (state === 'long') await expect(t(LONG_PROJECT.slice(0, 12)).first()).toBeVisible();
  }
}

for (const width of WIDTHS) {
  const phone = width < 500;
  test.describe(`the four places in five states · ${width}`, () => {
    if (phone) test.use({ hasTouch: true, isMobile: true });
    for (const p of PLACES) {
      for (const state of [...STATES, ...(EXTRA_STATES[p.id] ?? [])]) {
        test(`${p.label} · ${state} · ${width}`, async ({ page }) => {
          const { errs } = await open(page, p.id, state, width);
          await settle(page); // the fonts are in and the boxes hold still on two reads in a row
          await shot(page, page, `states-${p.id}-${state}-${width}`); // taken BEFORE the checks: a red scene still leaves its picture
          try { await expectState(page, p.id, state); } catch (e) {
            throw new Error(`${(e as Error).message}\n--- the page says: ${(await page.evaluate(() => document.body.innerText)).replace(/\s+/g, ' ').slice(0, 700)}\n--- page errors: ${errs.join(' | ') || 'none'}`, { cause: e });
          }
          await assertScene(page, p.id, `${p.id}-${state}-${width}`, phone);
          expect(errs, `${p.label} ${state} ${width}: the page threw`).toEqual([]);
        });
      }
    }
  });
}

test('pressKey: only the side under 44 is in a `small` key — a text link\'s width (letters) differs 2 px Mac ↔ Linux and must not decide', () => {
  expect(pressKey('리뷰 에이전트', 108, 20)).toBe(pressKey('리뷰 에이전트', 106, 20)); // the CI value and the Mac value are the same key
  expect(pressKey('리뷰 에이전트', 108, 20)).toBe('리뷰 에이전트 h20');
  expect(pressKey('SPAN', 24, 44)).toBe('SPAN w24');
  expect(pressKey('x', 24, 20)).toBe('x 24x20');
});

// the shell's own chrome (measured once: it is the same in every scene)
test('the shell chrome (top bar · icon rail · phone tab bar): the non-ds parts it draws are exactly the listed ones', async ({ page }) => {
  await open(page, 'home', 'default', 1440);
  await settle(page);
  expect((await measure(page)).chromeOldSlots, 'the chrome draws other non-ds parts than CHROME_OLD').toEqual(CHROME_OLD);
});
