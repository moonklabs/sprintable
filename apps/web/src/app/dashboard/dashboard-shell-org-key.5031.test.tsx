// @vitest-environment jsdom
//
// story 5031 (PO 가름 ③) — the shell's page body is KEYED by the shell's organization. A switch of organization (the switcher · the org hint banner · an address of another organization) keeps the
// layout and the shell mounted and only refreshes them, so a screen whose requests carry no organization in the URL (the organization rides on the session · X-Org-Id) never asked again and kept
// the old organization's data. With the key the body is mounted anew when — and only when — the organization changes: the same as a reload.
// (a) the probe: organization changes → a new mount with fresh state; every normal flow that does NOT change the organization (another project · another page · the org-sync's token catching up with
//     the path · the `me` org field moving while the token org stays) → no remount.  (b) REAL screens inside the real shell ask again with the NEW organization's header and show its answer.
//     (c) what is outside the key (the bars · the list column's open state · the panels · the dock) is not remounted and keeps its state.
// The context is built from props (no real two-organization account): the tests re-render the real shell with other props, as the server layout does after `router.refresh()`.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, type ReactNode, useEffect, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';

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
const outside = { sidebar: { mounts: 0 }, rail: { mounts: 0 }, bar: { mounts: 0 }, dock: { mounts: 0 }, sidebarState: 0, setSidebarState: undefined as undefined | ((n: number) => void) };
const bump = (slot: { mounts: number }) => { slot.mounts += 1; };
function useMountCount(slot: { mounts: number }) { useEffect(() => { bump(slot); }, [slot]); }
vi.mock('@/components/realtime-provider', () => ({ RealtimeProvider: pass, useSseMultiplexerContext: () => null }));
vi.mock('@/components/auth/session-expired-dialog', () => ({ SessionExpiredDialog: none }));
// the real ToastProvider (the real screens read `useToast`)
vi.mock('@/components/nav/bottom-dock', () => ({ BottomDock: () => { useMountCount(outside.dock); return null; } }));
vi.mock('@/components/nav/app-sidebar', () => ({
  AppSidebar: () => {
    useMountCount(outside.sidebar);
    const [n, setN] = useState(0);
    useEffect(() => { outside.sidebarState = n; outside.setSidebarState = setN; }, [n]);
    return null;
  },
}));
vi.mock('@/components/nav/nav-rail', () => ({ NavRail: () => { useMountCount(outside.rail); return null; } }));
vi.mock('@/components/nav/mobile-tab-bar', () => ({ MobileTabBar: none }));
vi.mock('@/components/nav/top-bar', () => ({ TopBar: () => { useMountCount(outside.bar); return null; } }));
const listColumn = { open: undefined as boolean | undefined, setOpen: undefined as ((v: boolean) => void) | undefined };
vi.mock('@/components/ui/sidebar', () => ({
  SidebarProvider: ({ children, open, onOpenChange }: { children?: ReactNode; open?: boolean; onOpenChange?: (v: boolean) => void }) => {
    listColumn.open = open; listColumn.setOpen = onOpenChange; return <>{children}</>;
  },
  SidebarInset: pass,
  useSidebar: () => ({ open: listColumn.open ?? true, toggleSidebar: () => listColumn.setOpen?.(!(listColumn.open ?? true)) }),
}));
vi.mock('@/components/ui/contextual-panel-layout', () => ({
  ContextualPanelLayout: ({ children }: { children?: ReactNode }) => <>{children}</>,
  useContextualPanelState: () => ({ inlinePanelOpen: false, drawerOpen: false, togglePanel: () => {} }),
}));
vi.mock('@/components/presence/team-presence-panel', () => ({ TeamPresencePanel: none }));
vi.mock('@/components/presence/use-team-presence', () => ({ useTeamPresence: () => [] }));
vi.mock('@/components/presence/use-agent-auth-failures', () => ({ useAgentAuthFailures: () => ({}) }));
vi.mock('@/hooks/use-chat-unread-total', () => ({ useChatUnreadTotal: () => 0 }));
vi.mock('@/components/release-notes/release-notes-gate', () => ({ ReleaseNotesProvider: pass }));
vi.mock('@/contexts/refresh-context', () => ({ RefreshProvider: pass }));
vi.mock('@/components/presence/team-presence-toggle', () => ({ TeamPresenceToggleProvider: pass }));
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
const probe = { mounts: 0, unmounts: 0, setN: undefined as undefined | ((n: number) => void), n: 0 };
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
  listColumn.open = undefined;
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

describe('셸 밖은 key 밖이다 — 조직이 바뀌어도 막대 · 목록 칸 · 쪽 막대가 그대로(story 5031)', () => {
  it('⭐막대 · 길잡이 · 위 막대 · 하단 덮개는 다시 붙지 않고, 접어 둔 목록 칸과 길잡이 안 상태도 그대로다', async () => {
    await render({});
    await act(async () => { listColumn.setOpen?.(false); outside.setSidebarState?.(7); });
    expect(listColumn.open).toBe(false);
    await render({ jwtOrgId: ORG_B, orgId: ORG_B });
    expect(probe.mounts).toBe(2); // the body was mounted anew …
    expect(outside).toMatchObject({ sidebar: { mounts: 1 }, rail: { mounts: 1 }, bar: { mounts: 1 }, dock: { mounts: 1 } }); // … the frame was not (reverted/moved inside the key → 2)
    expect(listColumn.open).toBe(false); // the folded list column stays folded
    expect(outside.sidebarState).toBe(7);
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
  if (url.startsWith('/api/team-members?type=agent')) return { data: [{ id: 'ag-a', name: '에이 조직 에이전트', type: 'agent', is_active: true, runtime_type: 'claude' }] };
  return {};
};
answers[ORG_B] = (url) => {
  if (url.startsWith('/api/events/definitions')) return [defRow(ORG_B, 'custom.beta', '비 조직의 이벤트'), defRow(ORG_B, 'custom.beta2', '비 조직의 둘째 이벤트')]; // B has two: the tab's count says which organization answered
  if (url.startsWith('/api/org-members')) return { data: [{ id: 'm-b', name: '비 조직 멤버', email: 'b@x.io', role: 'member', user_id: 'u-b' }] };
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
