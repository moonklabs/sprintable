// @vitest-environment jsdom
//
// story 5031 (PO 가름 ③) — the shell's page body is KEYED by the shell's organization. A switch of organization (the switcher · the org hint banner · an address of another organization) keeps the
// layout and the shell mounted and only refreshes them, so a screen whose requests carry no organization in the URL (the organization rides on the session · X-Org-Id) never asked again and kept
// the old organization's data. With the key the body is mounted anew when — and only when — the organization changes: the same as a reload.
// (a) the probe: organization changes → a new mount with fresh state; every normal flow that does NOT change the organization (another project · another page · the org-sync's token catching up with
//     the path · the `me` org field moving while the token org stays) → no remount.  (b) REAL screens inside the real shell ask again with the NEW organization's header and show its answer.
//     (c) what is outside the key is not remounted and keeps its state. REAL parts here: the sidebar provider (the list column's folded state · `useSidebar`), the contextual panel layout and its state, the presence-toggle provider,
//     the toast provider (a toast kept across the switch, read through the real `useToast`). MOCKED parts (their mount counts are all this file says of them; the real ones are read from the code only): the icon bar, the list column's
//     content (AppSidebar), the top bar, the bottom dock's own drawing, the presence panel's content, the command palette and the switcher dialog (they live inside AppSidebar / TopBar, which are outside the key by the shell's tree).
// (d) the ORDER: a switch is `push` (the new page mounts under the OLD organization: same key, old header — the known cost) THEN `router.refresh()` (the organization changes: the body is mounted anew, new header) — not one render that changes everything.
// The context is built from props (no real two-organization account): the tests re-render the real shell with other props, as the server layout does after `router.refresh()`.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, type ReactNode, useEffect, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { useToast } from '@/components/ui/toast';
import { useSidebar } from '@/components/ui/sidebar';
import { useTeamPresenceToggle } from '@/components/presence/team-presence-toggle';

const nav = { pathname: '/chats', search: '' };
vi.mock('next/navigation', () => ({
  usePathname: () => nav.pathname,
  useSearchParams: () => new URLSearchParams(nav.search),
  useRouter: () => ({ replace: vi.fn(), push: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
}));
const { reopenMock, clearMock, retryMock } = vi.hoisted(() => ({ reopenMock: vi.fn(() => true), clearMock: vi.fn(), retryMock: vi.fn() }));
vi.mock('@/lib/hard-reload', () => ({ reopenCurrentUrlOnce: reopenMock, clearReopenMarker: clearMock, retryReopenCurrentUrl: retryMock }));

const pass = ({ children }: { children?: ReactNode }) => <>{children}</>;
const none = () => null;
const outside = { sidebar: { mounts: 0 }, rail: { mounts: 0 }, bar: { mounts: 0 }, dock: { mounts: 0 }, sidebarState: 0, setSidebarState: undefined as undefined | ((n: number) => void), frame: {} as { listOpen?: boolean; toggleList?: () => void; panelOpen?: boolean; togglePanel?: () => void } };
const bump = (slot: { mounts: number }) => { slot.mounts += 1; };
function useMountCount(slot: { mounts: number }) { useEffect(() => { bump(slot); }, [slot]); }
vi.mock('@/hooks/use-chat-sse', () => ({ useChatSse: () => ({ connected: true, polling: false }) }));
vi.mock('@/hooks/use-auto-refresh', () => ({ useAutoRefresh: () => {} }));
vi.mock('@/components/realtime-provider', () => ({ RealtimeProvider: pass, useSseMultiplexerContext: () => null }));
vi.mock('@/components/auth/session-expired-dialog', () => ({ SessionExpiredDialog: none }));
// the real ToastProvider (the real screens read `useToast`)
// the dock is a REAL reader of the REAL toast provider (it draws the titles); the list column and the panel toggle are read through the REAL sidebar provider / presence-toggle provider
vi.mock('@/components/nav/bottom-dock', () => ({
  BottomDock: () => {
    useMountCount(outside.dock);
    const { toasts } = useToast();
    return <div data-testid="dock-toasts">{toasts.map((t) => t.title).join('|')}</div>;
  },
}));
vi.mock('@/components/nav/app-sidebar', () => ({
  AppSidebar: () => {
    useMountCount(outside.sidebar);
    const [n, setN] = useState(0);
    const { open, toggleSidebar } = useSidebar();
    useEffect(() => { outside.sidebarState = n; outside.setSidebarState = setN; }, [n]);
    useEffect(() => { outside.frame = { ...outside.frame, listOpen: open, toggleList: toggleSidebar }; });
    return null;
  },
}));
vi.mock('@/components/nav/nav-rail', () => ({ NavRail: () => { useMountCount(outside.rail); return null; } }));
vi.mock('@/components/nav/mobile-tab-bar', () => ({ MobileTabBar: none }));
// the top bar sits INSIDE the scroll shell, where the presence-toggle provider is: it reads the REAL provider (the open panel's state)
vi.mock('@/components/nav/top-bar', () => ({
  TopBar: () => {
    useMountCount(outside.bar);
    const panel = useTeamPresenceToggle();
    useEffect(() => { outside.frame = { ...outside.frame, panelOpen: panel?.open, togglePanel: panel?.toggle }; });
    return null;
  },
}));
vi.mock('@/components/presence/team-presence-panel', () => ({ TeamPresencePanel: none }));
vi.mock('@/components/presence/use-team-presence', () => ({ useTeamPresence: () => [] }));
vi.mock('@/components/presence/use-agent-auth-failures', () => ({ useAgentAuthFailures: () => ({}) }));
vi.mock('@/hooks/use-chat-unread-total', () => ({ useChatUnreadTotal: () => 0 }));
vi.mock('@/components/release-notes/release-notes-gate', () => ({ ReleaseNotesProvider: pass }));
vi.mock('@/contexts/refresh-context', () => ({ RefreshProvider: pass }));
vi.mock('@/components/dashboard/activation-checklist-banner', () => ({ ActivationChecklistBanner: none }));
vi.mock('@/components/nav/org-hint-banner', () => ({ OrgHintBanner: none }));
vi.mock('@/components/dashboard/reclaim-notice-alert', () => ({ ReclaimNoticeAlert: none }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ORG_A = 'org-5031-key-a';
const ORG_B = 'org-5031-key-b';
const P1 = 'proj-key-1';
const P2 = 'proj-key-2';
const memberships = [
  { projectId: P1, projectName: 'Project One', projectSlug: 'one', orgId: ORG_A },
  { projectId: P2, projectName: 'Project Two', projectSlug: 'two', orgId: ORG_A },
];
const orgList = [
  { orgId: ORG_A, orgName: 'A', orgSlug: 'a', role: 'admin' },
  { orgId: ORG_B, orgName: 'B', orgSlug: 'b', role: 'admin' },
];
/** what the server layout hands the shell: the token's org (jwtOrgId), the `me` org (orgId), the org of the address (pathOrgId) — flat screens have no pathOrgId */
const base = {
  currentTeamMemberId: 'tm-1', orgId: ORG_A, jwtOrgId: ORG_A as string | undefined, pathOrgId: undefined as string | undefined,
  projectId: P1, projectName: 'Project One', currentProjectSlug: 'one',
  projectMemberships: memberships, orgMemberships: orgList, role: 'admin',
  pathProjectId: undefined as string | undefined, serverResolvedPath: undefined as string | undefined,
};
type Props = typeof base;

let root: Root;
let container: HTMLDivElement;
const probe = { mounts: 0, unmounts: 0, setN: undefined as undefined | ((n: number) => void), n: 0, addToast: undefined as undefined | ReturnType<typeof useToast>['addToast'] };
function Probe() {
  const [n, setN] = useState(0);
  useEffect(() => { probe.setN = setN; probe.n = n; }, [n]);
  useEffect(() => { probe.mounts += 1; return () => { probe.unmounts += 1; }; }, []);
  return <div data-testid="probe" data-n={n} />;
}

const sent: Array<{ url: string; org?: string }> = [];
// an organization-wide server: it answers for the organization the request carries in X-Org-Id (the URL never says which)
const answers: Record<string, (url: string) => unknown> = {};
beforeAll(async () => {
  // the real sidebar / panel layout read matchMedia: a wide window (the inline presence panel is supported), not a phone
  window.matchMedia = ((q: string) => ({ matches: q.includes('1536'), media: q, addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {}, onchange: null, dispatchEvent: () => false })) as unknown as typeof window.matchMedia;
  window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const h = new Headers(init?.headers);
    const url = String(input);
    const org = h.get('X-Org-Id') ?? undefined;
    sent.push({ url, org });
    const body = org && answers[org] ? answers[org]!(url) : {};
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  const { installProjectHeaderInterceptor } = await import('@/lib/project-context-client');
  installProjectHeaderInterceptor();
  container = document.createElement('div');
  document.body.appendChild(container);
});
afterAll(() => { container.remove(); });

beforeEach(async () => {
  if (root) await act(async () => { root.unmount(); });
  root = createRoot(container);
  sent.length = 0;
  probe.mounts = 0; probe.unmounts = 0; probe.n = 0;
  outside.sidebar.mounts = 0; outside.rail.mounts = 0; outside.bar.mounts = 0; outside.dock.mounts = 0;
  outside.frame = {};
  try { window.localStorage.clear(); } catch { /* none */ }
  nav.pathname = '/chats'; nav.search = '';
});

async function render(props: Partial<Props>, child: ReactNode = <Probe />) {
  const { DashboardShell } = await import('./dashboard-shell');
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
        <DashboardShell {...base} {...props}>{child}</DashboardShell>
      </NextIntlClientProvider>,
    );
  });
  await act(async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); });
}

describe('셸 본문 key — 조직이 바뀔 때만 다시 붙는다 (story 5031)', () => {
  it('⭐조직 A→B(토큰 조직 · 평면 화면): 본문이 새로 마운트되고(마운트 +1 · 언마운트 +1) 상태가 초기화된다', async () => {
    await render({});
    expect(probe.mounts).toBe(1);
    await act(async () => { probe.setN?.(3); });
    expect(probe.n).toBe(3);
    await render({ jwtOrgId: ORG_B, orgId: ORG_B });
    expect(probe.mounts).toBe(2); // reverted (no key) → 1
    expect(probe.unmounts).toBe(1);
    expect(probe.n).toBe(0); // fresh state — what a reload gives
  });

  it('⭐토큰 조직만 A→B로 바뀌고 `me` 조직(프로젝트 사슬 값)은 옛 값 그대로여도(프로젝트 없는 조직으로 전환 · story 2873) 다시 붙는다', async () => {
    await render({});
    await render({ jwtOrgId: ORG_B, orgId: ORG_A });
    expect(probe.mounts).toBe(2);
  });

  it('⭐조직 A→B(주소의 조직 pathOrgId가 바뀜 · 토큰은 그대로): 다시 붙는다', async () => {
    await render({ pathOrgId: ORG_A, pathProjectId: P1, serverResolvedPath: '/a/one/flow' });
    nav.pathname = '/b/one/flow';
    await render({ pathOrgId: ORG_B, pathProjectId: P1, serverResolvedPath: '/b/one/flow', projectMemberships: [{ ...memberships[0]!, orgId: ORG_B }] });
    expect(probe.mounts).toBe(2);
  });

  it('⭐같은 조직 안의 흐름은 다시 붙지 않는다 — 현재 프로젝트 · 쪽(pathname) · `?p=` 만 바뀜', async () => {
    await render({});
    await act(async () => { probe.setN?.(2); });
    await render({ projectId: P2, projectName: 'Project Two', currentProjectSlug: 'two' });
    nav.pathname = '/inbox'; nav.search = 'p=proj-key-2';
    await render({ projectId: P2, projectName: 'Project Two', currentProjectSlug: 'two' });
    expect(probe.mounts).toBe(1);
    expect(probe.n).toBe(2); // the state stayed
  });

  it('⭐org-sync: 주소의 조직(B)은 그대로 · 토큰 조직이 A→B로 따라붙는 중(router.refresh) — 흔들리지 않는다(다시 붙기 0)', async () => {
    nav.pathname = '/b/one/flow';
    const scoped = { pathOrgId: ORG_B, pathProjectId: P1, serverResolvedPath: '/b/one/flow', projectMemberships: [{ ...memberships[0]!, orgId: ORG_B }] };
    await render({ ...scoped, jwtOrgId: ORG_A, orgId: ORG_A }); // deep link into B while the token is still A's
    expect(probe.mounts).toBe(1);
    await render({ ...scoped, jwtOrgId: ORG_B, orgId: ORG_B }); // the token caught up
    expect(probe.mounts).toBe(1);
    expect(probe.unmounts).toBe(0);
  });

  it('⭐`me`의 조직(orgId · 프로젝트 사슬 값)만 움직이고 토큰 조직이 그대로면 다시 붙지 않는다(셸의 조직은 토큰 조직 우선)', async () => {
    await render({});
    await render({ orgId: ORG_B }); // jwtOrgId still A → the shell's organization is A
    await render({ orgId: undefined });
    expect(probe.mounts).toBe(1);
  });

  it('⭐평면 화면에서 주소의 조직이 없던 쪽이 토큰과 같은 조직으로 채워져도(undefined→A, 값 같음) 다시 붙지 않는다', async () => {
    nav.pathname = '/a/one/flow';
    await render({ pathOrgId: undefined });
    await render({ pathOrgId: ORG_A, pathProjectId: P1, serverResolvedPath: '/a/one/flow' });
    expect(probe.mounts).toBe(1);
  });

  it('⭐새 조직의 첫 렌더가 «새 조직의 요청 머리»와 함께 나간다 — 다시 붙은 본문의 첫 요청에 옛 조직 머리가 실리지 않는다', async () => {
    function Asker() { useEffect(() => { void fetch('/api/probe-ask'); }, []); return null; }
    await render({}, <Asker />);
    await render({ jwtOrgId: ORG_B, orgId: ORG_B }, <Asker />);
    const asks = sent.filter((s) => s.url === '/api/probe-ask');
    expect(asks.map((a) => a.org)).toEqual([ORG_A, ORG_B]); // one ask per organization, each with its own header
  });
});

describe('셸 밖은 key 밖이다 — 조직이 바뀌어도 막대 · 목록 칸 · 쪽 막대 · 토스트가 그대로(story 5031)', () => {
  it('⭐진짜 사이드바 제공자의 접힘 · 진짜 패널 상태 · 진짜 토스트 제공자의 토스트는 그대로이고, 막대 · 길잡이 · 위 막대 · 하단 덮개는 다시 붙지 않는다', async () => {
    function ToastChild() {
      const { addToast } = useToast();
      useEffect(() => { probe.addToast = addToast; });
      return null;
    }
    nav.pathname = '/inbox'; // a screen that does not own the list column (the chats screen folds it by itself)
    await render({}, <><Probe /><ToastChild /></>);
    expect(outside.frame.listOpen).toBe(true);
    expect(outside.frame.panelOpen).toBe(true);
    await act(async () => { outside.frame.toggleList?.(); outside.frame.togglePanel?.(); outside.setSidebarState?.(7); probe.addToast?.({ title: 'kept-toast', type: 'info' }); });
    expect(outside.frame.listOpen).toBe(false);
    expect(outside.frame.panelOpen).toBe(false);
    expect(container.querySelector('[data-testid="dock-toasts"]')?.textContent).toBe('kept-toast');
    await render({ jwtOrgId: ORG_B, orgId: ORG_B }, <><Probe /><ToastChild /></>);
    expect(probe.mounts).toBe(2); // the body was mounted anew …
    expect(outside).toMatchObject({ sidebar: { mounts: 1 }, rail: { mounts: 1 }, bar: { mounts: 1 }, dock: { mounts: 1 } }); // … the frame was not (reverted/moved inside the key → 2)
    expect(outside.frame.listOpen).toBe(false); // the folded list column stays folded (real sidebar provider)
    expect(outside.frame.panelOpen).toBe(false); // the closed presence panel stays closed (real panel state)
    expect(outside.sidebarState).toBe(7);
    expect(container.querySelector('[data-testid="dock-toasts"]')?.textContent, 'the toast stays (real toast provider, outside the key)').toBe('kept-toast');
  });
});

// ── (b) REAL screens inside the real shell ───────────────────────────────────────────────────────────────────────────────────────────────────
// each screen is the real default export of its page. The server answers for the organization the request's X-Org-Id carries.
const defRow = (org: string, key: string, name: string) => ({
  id: `def-${key}`, key, org_id: org, name, description: '', payload_schema: { type: 'object', properties: {}, required: [] }, routing: {},
  block_template: null, enabled: true, version: 1, stage_metadata: null,
});
answers[ORG_A] = (url) => {
  if (url.startsWith('/api/events/definitions')) return [defRow(ORG_A, 'custom.alpha', '에이 조직의 이벤트')];
  if (url.startsWith('/api/org-members')) return { data: [{ id: 'm-a', name: '에이 조직 멤버', email: 'a@x.io', role: 'member', user_id: 'u-a' }] };
  if (url.startsWith('/api/conversations?')) return { data: [{ id: 'conv-a', type: 'group', title: '에이 조직의 대화방', latest_message: null, updated_at: '2026-11-07T01:00:00Z', unread_count: 0, project_id: null, project_name: null }], total: 1 };
  if (url.startsWith('/api/team-members?type=agent')) return { data: [{ id: 'ag-a', name: '에이 조직 에이전트', type: 'agent', is_active: true, runtime_type: 'claude' }] };
  return {};
};
answers[ORG_B] = (url) => {
  if (url.startsWith('/api/events/definitions')) return [defRow(ORG_B, 'custom.beta', '비 조직의 이벤트'), defRow(ORG_B, 'custom.beta2', '비 조직의 둘째 이벤트')]; // B has two: the tab's count says which organization answered
  if (url.startsWith('/api/org-members')) return { data: [{ id: 'm-b', name: '비 조직 멤버', email: 'b@x.io', role: 'member', user_id: 'u-b' }] };
  if (url.startsWith('/api/conversations?')) return { data: [{ id: 'conv-b', type: 'group', title: '비 조직의 대화방', latest_message: null, updated_at: '2026-11-07T01:00:00Z', unread_count: 0, project_id: null, project_name: null }], total: 1 };
  if (url.startsWith('/api/team-members?type=agent')) return { data: [{ id: 'ag-b', name: '비 조직 에이전트', type: 'agent', is_active: true, runtime_type: 'claude' }] };
  return {};
};
// `per`: how many times ONE mount of the screen asks that URL (the events page asks twice: its own read and the marketing-recipes hook's)
const SCREENS: Array<{ name: string; path: string; ask: string; per: number; a: string; b: string; load: () => Promise<{ default: () => ReactNode }> }> = [
  { name: 'organization/events', path: '/organization/events', ask: '/api/events/definitions', per: 2, a: '개발 워크플로우 1', b: '개발 워크플로우 2', load: () => import('../(authenticated)/organization/events/page') },
  { name: 'organization/roles', path: '/organization/roles', ask: '/api/org-members', per: 1, a: '에이 조직 멤버', b: '비 조직 멤버', load: () => import('../(authenticated)/organization/roles/page') },
  { name: 'organization/workforce/api-keys', path: '/organization/workforce/api-keys', ask: '/api/team-members?type=agent', per: 1, a: '에이 조직 에이전트', b: '비 조직 에이전트', load: () => import('../(authenticated)/organization/workforce/api-keys/page') },
];
describe('실제 화면 — 조직 A→B에서 다시 묻고 B의 답으로 바뀐다 (story 5031 · 셸 안 · 요청 머리로 조직을 가르는 서버)', () => {
  it.each(SCREENS)('⭐$name', async ({ path, ask, per, a, b, load }) => {
    nav.pathname = path;
    const Page = (await load()).default;
    await render({}, <Page />);
    expect(sent.filter((s) => s.url === ask).map((s) => s.org)).toEqual(Array(per).fill(ORG_A));
    expect(container.textContent).toContain(a);
    await render({ jwtOrgId: ORG_B, orgId: ORG_B }, <Page />);
    expect(sent.filter((s) => s.url === ask).map((s) => s.org)).toEqual([...Array(per).fill(ORG_A), ...Array(per).fill(ORG_B)]); // asked again, with B's header (reverted → only A's asks)
    expect(container.textContent).toContain(b);
    expect(container.textContent).not.toContain(a);
  });

  it.each(SCREENS)('⭐$name — 같은 조직에서 현재 프로젝트만 바뀌면 다시 묻지 않는다', async ({ path, ask, per, load }) => {
    nav.pathname = path;
    const Page = (await load()).default;
    await render({}, <Page />);
    nav.search = 'p=proj-key-2'; // the tab's own project moves (a flat screen's `?p=`)
    await render({ projectId: P2, projectName: 'Project Two', currentProjectSlug: 'two' }, <Page />);
    expect(sent.filter((s) => s.url === ask)).toHaveLength(per);
  });
});

// ── (d) the ORDER of a switch · (e) the path-unresolved gap · (f) the REAL chat list ─────────────────────────────────────────────────────────
// A switch is NOT one render that changes everything: the switcher awaits the session switch, `router.push`es the destination (the shell's props are the layout's old ones — the layout is not re-rendered by a push: the new page mounts under the OLD
// organization · same key · old X-Org-Id: the one KNOWN extra request) and THEN `router.refresh()` brings the new props (the organization changes: the body is mounted anew, its first request carries the new header).
describe('순서 — push 뒤에 refresh (story 5031)', () => {
  it('⭐① push: 새 쪽은 옛 조직 key 아래 붙고(재마운트 0 · 요청 머리 = A로 핀) · refresh: 본문이 다시 붙고 첫 요청 머리 = B — 요청 둘(A 하나 · B 하나)', async () => {
    function Page() { useEffect(() => { void fetch('/api/order-ask'); }, []); return null; }
    const body = () => <><Probe /><Page key={nav.pathname} /></>;
    nav.pathname = '/chats';
    await render({}, body());
    expect(probe.mounts).toBe(1);
    expect(sent.filter((x) => x.url === '/api/order-ask').map((x) => x.org)).toEqual([ORG_A]); // the page the person was on
    sent.length = 0;
    // (1) the push: the new destination — the shell's props are the old ones (organization A)
    nav.pathname = '/inbox';
    await render({}, body());
    expect(probe.mounts, 'a push alone does not remount the body (same organization key) — reverted to key-by-pathname → 2').toBe(1);
    expect(sent.filter((x) => x.url === '/api/order-ask').map((x) => x.org), 'the pushed page mounted under the OLD organization: its request carries A (the known extra request)').toEqual([ORG_A]);
    // (2) the refresh: the new props (token organization B)
    await render({ jwtOrgId: ORG_B, orgId: ORG_B }, body());
    expect(probe.mounts, 'the refresh remounts the body once').toBe(2);
    expect(sent.filter((x) => x.url === '/api/order-ask').map((x) => x.org), 'two requests across the switch: one under A (the push), one under B (the refresh)').toEqual([ORG_A, ORG_B]);
    // …and nothing more once it has settled
    await render({ jwtOrgId: ORG_B, orgId: ORG_B }, body());
    expect(probe.mounts).toBe(2);
    expect(sent.filter((x) => x.url === '/api/order-ask')).toHaveLength(2);
  });
});

describe('경로가 늦게 풀리는 동안(pathUnresolved) — 본문이 비었다가 돌아온다 (story 5031)', () => {
  const scopedA = { pathOrgId: ORG_A, pathProjectId: P1, serverResolvedPath: '/a/one/flow' };
  it('⭐② 같은 조직: 본문이 null이던 렌더 뒤 같은 key로 복귀 — 새로 한 번 붙는 것 말고 추가 재마운트 0', async () => {
    nav.pathname = '/a/one/flow';
    await render({ ...scopedA });
    expect(probe.mounts).toBe(1);
    nav.pathname = '/a/ghost/flow'; // no such project in the person's list: the body is not drawn (the address is re-opened by the server)
    await render({ ...scopedA });
    expect(container.querySelector('[data-testid="probe"]'), 'the body is gone while the path is unresolved').toBeNull();
    expect(probe.unmounts).toBe(1);
    nav.pathname = '/a/one/flow';
    await render({ ...scopedA });
    expect(probe.mounts, 'one new mount on the way back, no extra remount').toBe(2);
    await render({ ...scopedA });
    expect(probe.mounts).toBe(2);
    expect(probe.unmounts).toBe(1);
  });

  it('⭐② 풀리는 순간 조직이 바뀌는 경우(딥링크 · 주소의 조직 B ≠ 토큰 조직 A): 그 복귀도 한 번 붙는 것이 전부이고, 첫 요청 머리 = B', async () => {
    function Asker() { useEffect(() => { void fetch('/api/resolve-ask'); }, []); return null; }
    nav.pathname = '/a/one/flow';
    await render({ ...scopedA });
    nav.pathname = '/a/ghost/flow';
    await render({ ...scopedA });
    expect(probe.unmounts).toBe(1);
    sent.length = 0;
    nav.pathname = '/b/one/flow';
    await render({ pathOrgId: ORG_B, pathProjectId: P1, serverResolvedPath: '/b/one/flow', projectMemberships: [{ ...memberships[0]!, orgId: ORG_B }] }, <><Probe /><Asker /></>);
    expect(probe.mounts, 'one mount, not two (nothing was mounted to remount)').toBe(2);
    expect(sent.filter((x) => x.url === '/api/resolve-ask').map((x) => x.org)).toEqual([ORG_B]);
  });
});

describe('실제 채팅 목록 — 셸 key만으로 조직 A→B에서 다시 묻는다 (story 5031 · 목록 쪽 고침 없이)', () => {
  it('⭐ChatListView(실제)를 셸 안에 두고 조직을 바꾸면 B의 머리로 다시 묻고 B의 방만 남는다', async () => {
    nav.pathname = '/chats';
    const { ChatListView } = await import('@/components/chat/chat-list-view'); // after the mocks (a static import would load the mocked modules first)
    const list = () => <ChatListView projectId={null} currentTeamMemberId="me-1" />;
    await render({}, list());
    const asks = () => sent.filter((x) => x.url.startsWith('/api/conversations?limit')).map((x) => x.org);
    expect(asks()).toEqual([ORG_A]);
    expect(container.textContent).toContain('에이 조직의 대화방');
    await render({ jwtOrgId: ORG_B, orgId: ORG_B }, list());
    expect(asks(), 'asked again with B\'s header (reverted → one ask, A\'s rooms stay)').toEqual([ORG_A, ORG_B]);
    expect(container.textContent).toContain('비 조직의 대화방');
    expect(container.textContent).not.toContain('에이 조직의 대화방');
  });
});
