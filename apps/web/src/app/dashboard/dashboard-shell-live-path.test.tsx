// @vitest-environment jsdom
//
// story #4217(critical · 데이터 결함) — 셸의 현재 프로젝트는 **현재 pathname**에서, 인터셉터 ref는 **셸 수명**에 묶는다.
// 로컬 실측(수정 전): `(authenticated)` 공유 레이아웃이 클라이언트 이동에서 다시 렌더되지 않아 서버 prop(pathProjectId·slug)이
// B로 남고 그 값이 `?p=`보다 우선 → `/{ws}/charlie/flow` 화면의 API 요청 23/24가 `X-Project-Id: B` · 칸반 모양 쓰기
// (`project_id` = 컨텍스트 값)가 B에 저장. 셸 → 셸 밖 v3 화면 클라이언트 이동 뒤에도 옛 프로젝트·org 헤더가 실렸다(하드 로드는 0).
// 여기서는 실제 DashboardShell + 실제 인터셉터(project-context-client)로 같은 순서를 재현한다 — 서버 prop은 B에 고정하고
// pathname만 바꿔 다시 렌더(= 공유 레이아웃 클라이언트 이동), 자식 «페이지»는 경로마다 새로 마운트돼 첫 fetch를 낸다.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { act, type ReactNode, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const nav = { pathname: '/repro/beta/flow', search: '' };
// story #4226 — scoped 경로는 `?p=` 정규화를 안 한다(경로가 SSOT) · flat 경로의 드문 진입만 router.replace(Next가 아는 이동 →
// useSearchParams 반영). router.replace는 호출을 기록하고 nav.search를 갱신해 Next 동작을 비춘다.
const routerReplace = vi.fn((u: string) => { nav.search = u.split('?')[1] ?? ''; });
vi.mock('next/navigation', () => ({
  usePathname: () => nav.pathname,
  useSearchParams: () => new URLSearchParams(nav.search),
  useRouter: () => ({ replace: routerReplace, push: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
}));
vi.mock('next-intl', () => ({ useTranslations: () => (k: string) => k }));
const { reopenMock, clearMock, retryMock } = vi.hoisted(() => ({ reopenMock: vi.fn(() => true), clearMock: vi.fn(), retryMock: vi.fn() }));
vi.mock('@/lib/hard-reload', () => ({ reopenCurrentUrlOnce: reopenMock, clearReopenMarker: clearMock, retryReopenCurrentUrl: retryMock }));

const pass = ({ children }: { children?: ReactNode }) => <>{children}</>;
const none = () => null;
const sidebar = { slug: undefined as string | undefined };
vi.mock('@/components/realtime-provider', () => ({ RealtimeProvider: pass }));
vi.mock('@/components/auth/session-expired-dialog', () => ({ SessionExpiredDialog: none }));
vi.mock('@/components/ui/toast', () => ({ ToastProvider: pass }));
vi.mock('@/components/nav/bottom-dock', () => ({ BottomDock: none }));
vi.mock('@/components/nav/app-sidebar', () => ({
  AppSidebar: (p: { currentProjectSlug?: string }) => { sidebar.slug = p.currentProjectSlug; return null; },
}));
vi.mock('@/components/nav/mobile-tab-bar', () => ({ MobileTabBar: none }));
vi.mock('@/components/nav/top-bar', () => ({ TopBar: none }));
vi.mock('@/components/nav/top-bar-context', () => ({ TopBarProvider: pass, useTopBar: () => ({ setScrollContainer: () => {} }) }));
vi.mock('@/components/ui/sidebar', () => ({ SidebarProvider: pass, SidebarInset: pass }));
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

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ORG = 'org-1';
const A = 'proj-alpha', B = 'proj-beta', C = 'proj-charlie';
const memberships = [
  { projectId: A, projectName: 'Project Alpha', projectSlug: 'alpha', orgId: ORG },
  { projectId: B, projectName: 'Project Beta', projectSlug: 'beta', orgId: ORG },
  { projectId: C, projectName: 'Project Charlie', projectSlug: 'charlie', orgId: ORG },
];
// 서버 prop — 하드 로드 B 때 값 그대로(공유 레이아웃이라 클라이언트 이동에서 바뀌지 않는다). 세션 프로젝트는 A.
const serverProps = {
  currentTeamMemberId: 'tm-1', orgId: ORG, projectId: A, projectName: 'Project Beta', currentProjectSlug: 'beta',
  projectMemberships: memberships, orgMemberships: [{ orgId: ORG, orgName: 'Repro', orgSlug: 'repro' }],
  pathOrgId: ORG, pathProjectId: B, jwtOrgId: ORG, serverResolvedPath: '/repro/beta/flow',
};

interface Sent { url: string; project?: string; org?: string; body?: Record<string, unknown> }
const sent: Sent[] = [];
const seen: { name?: string; projectId?: string }[] = [];

let root: Root;
let container: HTMLDivElement;

beforeAll(async () => {
  // 실제 인터셉터가 감쌀 «네트워크» — 인터셉터가 붙인 헤더와 본문을 그대로 기록한다.
  window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const h = new Headers(init?.headers);
    sent.push({
      url: String(input), project: h.get('X-Project-Id') ?? undefined, org: h.get('X-Org-Id') ?? undefined,
      body: typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : undefined,
    });
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  // 앱 루트 관문(FetchGateInstaller, PR #4565) — 셸 유무와 무관하게 상주.
  const { installProjectHeaderInterceptor } = await import('@/lib/project-context-client');
  installProjectHeaderInterceptor();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterAll(() => { container.remove(); });

async function renderShellAt(pathname: string, overrides: Partial<typeof serverProps> = {}) {
  nav.pathname = pathname;
  const { DashboardShell, useDashboardContext } = await import('./dashboard-shell');
  // 경로마다 새로 마운트되는 «페이지» — 첫 effect에서 읽기 1건 + 칸반 추가와 같은 모양의 쓰기 1건(project_id = 컨텍스트 값).
  function Page() {
    const ctx = useDashboardContext();
    seen.push({ name: ctx.projectName, projectId: ctx.projectId });
    useEffect(() => {
      void fetch('/api/stories');
      void fetch('/api/stories', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ project_id: ctx.projectId, title: 't' }) });
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
    return null;
  }
  await act(async () => {
    root.render(<DashboardShell {...serverProps} {...overrides}><Page key={pathname} /></DashboardShell>);
  });
  await act(async () => { for (let i = 0; i < 4; i++) await Promise.resolve(); });
}

const since = (n: number) => sent.slice(n);

describe('셸 현재 프로젝트 = 현재 pathname · 인터셉터 ref = 셸 수명(story #4217)', () => {
  it('하드 B → 클라이언트 이동 C(서버 prop은 B에 고정) → 컨텍스트·이름·사이드바 slug·읽기 헤더·쓰기 project_id 전부 C', async () => {
    await renderShellAt('/repro/beta/flow');
    expect(seen.at(-1)?.projectId).toBe(B);

    const mark = sent.length;
    routerReplace.mockClear();
    await renderShellAt('/repro/charlie/flow');
    expect(seen.at(-1)).toEqual({ name: 'Project Charlie', projectId: C });
    expect(sidebar.slug).toBe('charlie');
    const after = since(mark);
    expect(after.length).toBeGreaterThanOrEqual(2);
    for (const r of after) expect(r.project, r.url).toBe(C);
    // ⭐쓰기 — C 화면에서 만든 스토리가 C로(수정 전 로컬 실측은 B에 저장).
    const write = after.find((r) => r.body);
    expect(write?.body?.project_id).toBe(C);
    // ⭐story #4226 — scoped 경로는 경로가 프로젝트 SSOT라 `?p=`를 쓰지 않는다(현재 페이지 RSC 재요청 0).
    expect(routerReplace).not.toHaveBeenCalled();
  });

  it('⭐story #4226 — 전환 «대기 중 목표»: 이동이 커밋되지 않은 동안은 유지 · 목표 프로젝트로 오면 지움', async () => {
    const { getPendingProjectTarget, setPendingProjectTarget } = await import('@/lib/pending-project-switch');
    await renderShellAt('/repro/beta/flow');
    setPendingProjectTarget('proj-not-yet', '/repro/beta/flow');
    await renderShellAt('/repro/beta/flow'); // 같은 주소 재렌더 = 아직 커밋된 이동 없음
    expect(getPendingProjectTarget()).toBe('proj-not-yet');
    setPendingProjectTarget(C, '/repro/beta/flow');
    await renderShellAt('/repro/charlie/flow');
    expect(getPendingProjectTarget()).toBeNull();
  });

  it('⭐story #4226(PO 23:38Z) — 전환이 커밋 전에 끊기면(뒤로 가기가 먼저 커밋) 목표를 지우고 flat 링크는 다시 현재 프로젝트', async () => {
    const { getPendingProjectTarget, setPendingProjectTarget } = await import('@/lib/pending-project-switch');
    const { useFlatHref } = await import('@/hooks/use-flat-href');
    function FlatLinkProbe() { return <a data-testid="flat-probe" href={useFlatHref()('/inbox?tab=gates')} />; }
    nav.search = '';
    const { DashboardShell } = await import('./dashboard-shell');
    const render = async (pathname: string) => {
      nav.pathname = pathname;
      await act(async () => { root.render(<DashboardShell {...serverProps}><FlatLinkProbe /></DashboardShell>); });
      await act(async () => { for (let i = 0; i < 4; i++) await Promise.resolve(); });
    };
    await render('/repro/beta/flow');
    setPendingProjectTarget(C, '/repro/beta/flow'); // 전환기가 charlie로 이동 시작
    await render('/repro/beta/flow');
    expect(container.querySelector('[data-testid="flat-probe"]')?.getAttribute('href')).toBe(`/inbox?tab=gates&p=${C}`);
    await render('/repro/beta/goals'); // 전환 커밋 전 다른 이동(뒤로 가기 등)이 먼저 커밋 — 여전히 beta
    expect(getPendingProjectTarget()).toBeNull();
    expect(container.querySelector('[data-testid="flat-probe"]')?.getAttribute('href')).toBe(`/inbox?tab=gates&p=${B}`);
  });

  it('⭐story #4226 — flat 경로의 드문 진입(`?p=` 없음)은 router.replace 한 번 · Next가 새 `p`를 읽은 뒤 재렌더 추가 0', async () => {
    nav.search = '';
    routerReplace.mockClear();
    await renderShellAt('/inbox', { pathProjectId: undefined, serverResolvedPath: undefined });
    expect(routerReplace).toHaveBeenCalledTimes(1);
    expect(routerReplace.mock.calls[0]![0]).toMatch(/^\/inbox\?p=/);
    await renderShellAt('/inbox', { pathProjectId: undefined, serverResolvedPath: undefined });
    expect(routerReplace).toHaveBeenCalledTimes(1);
  });

  it('scoped → flat 클라이언트 이동은 옛 서버 pathProjectId(B)를 쓰지 않는다 — `?p=`(탭 값) 기준(하드 로드와 같음)', async () => {
    nav.search = `p=${A}`;
    const mark = sent.length;
    await renderShellAt('/flow');
    expect(seen.at(-1)?.projectId).toBe(A);
    for (const r of since(mark)) expect(r.project, r.url).toBe(A);
  });

  it('⭐셸 → 셸 밖 화면(v3 단독) 클라이언트 이동 → 언마운트 뒤 같은 관문을 지나는 요청에 프로젝트·org 헤더 0', async () => {
    await renderShellAt('/repro/charlie/flow');
    await act(async () => { root.render(<></>); });
    const mark = sent.length;
    await fetch('/api/today');
    await fetch('/api/conversations', { method: 'POST', body: '{}' });
    for (const r of since(mark)) {
      expect(r.project, r.url).toBeUndefined();
      expect(r.org, r.url).toBeUndefined();
    }
  });

  it('⭐두 org에 같은 slug(`charlie`) → 현재 org 쪽 프로젝트(X-Org-Id와 범위 일치)', async () => {
    const OTHER_C = 'proj-other-charlie';
    const mixed = [{ projectId: OTHER_C, projectName: 'Other Charlie', projectSlug: 'charlie', orgId: 'org-other' }, ...memberships];
    await renderShellAt('/repro/beta/flow', { projectMemberships: mixed });
    const mark = sent.length;
    await renderShellAt('/repro/charlie/flow', { projectMemberships: mixed });
    expect(seen.at(-1)?.projectId).toBe(C);
    for (const r of since(mark)) { expect(r.project, r.url).toBe(C); expect(r.org, r.url).toBe(ORG); }
  });

  it('⭐scoped인데 스냅샷으로 못 풂(멤버십에 C 없음) → 전체 문서 이동 호출 · 그 전 B 헤더·B 본문 요청 0 · `?p=`B로 안 떨어짐', async () => {
    const withoutC = memberships.filter((m) => m.projectId !== C);
    await renderShellAt('/repro/beta/flow', { projectMemberships: withoutC });
    reopenMock.mockClear();
    const mark = sent.length;
    nav.search = `p=${B}`;
    await renderShellAt('/repro/charlie/flow', { projectMemberships: withoutC });
    expect(reopenMock).toHaveBeenCalledTimes(1);
    const after = since(mark);
    expect(after.filter((r) => r.project === B || r.body?.project_id === B)).toEqual([]);
    // 페이지를 마운트하지 않아 세션 프로젝트로 떨어지는 요청(헤더 없는 쓰기)도 0.
    expect(after.filter((r) => r.url.startsWith('/api/stories'))).toEqual([]);
    expect(new URLSearchParams(nav.search).get('p')).toBe(B); // 셸이 다시 쓰지 않았다(전체 이동이 서버 해석으로 교정)
    // 셸 밖 같은 관문을 지나는 요청도 이 사이엔 헤더 0.
    await fetch('/api/probe');
    expect(sent.at(-1)?.project).toBeUndefined();
    expect(sent.at(-1)?.org).toBeUndefined();
  });

  it('다른 org 경로로 클라이언트 이동 → 전체 문서 이동(옛 org·프로젝트로 안 떨어짐)', async () => {
    await renderShellAt('/repro/beta/flow');
    reopenMock.mockClear();
    await renderShellAt('/other-org/charlie/flow');
    expect(reopenMock).toHaveBeenCalledTimes(1);
  });

  it('⭐org·프로젝트 멤버십 조회 실패 + 새로고침으로 연 scoped 경로 → 전체 이동 0 · 서버 해석 프로젝트로(무한 새로고침 0)', async () => {
    await act(async () => { root.render(<></>); }); // 새 문서 = 셸 새로 마운트(서버가 이 경로를 해석 · serverResolvedPath)
    reopenMock.mockClear();
    const mark = sent.length;
    await renderShellAt('/repro/beta/flow', { orgMemberships: [], projectMemberships: [] });
    expect(reopenMock).not.toHaveBeenCalled();
    expect(seen.at(-1)?.projectId).toBe(B);
    for (const r of since(mark).filter((x) => x.url.startsWith('/api/stories'))) expect(r.project, r.url).toBe(B);
  });

  it('⭐이미 1회 다시 열었는데도 못 풂 → 빈 화면이 아니라 오류 상태 · 다시 시도 = 표지 지우고 전체 이동 · 페이지·헤더 0 유지', async () => {
    const withoutC = memberships.filter((m) => m.projectId !== C);
    await renderShellAt('/repro/beta/flow', { projectMemberships: withoutC });
    reopenMock.mockClear(); clearMock.mockClear();
    reopenMock.mockReturnValueOnce(false); // 이 주소는 이미 1회 다시 열었다
    const mark = sent.length;
    await renderShellAt('/repro/charlie/flow', { projectMemberships: withoutC });
    const retry = [...container.querySelectorAll('button')].find((b) => b.textContent?.includes('retry'));
    expect(container.textContent).toContain('projectOpenFailedTitle'); // 유나 확정 문안 키
    expect(container.textContent).toContain('projectOpenFailedDescription');
    expect(retry).toBeTruthy();
    expect(container.querySelector('a'), '보조 링크(«로그인으로 이동») 없음').toBeNull();
    // 390 좌우 여백(유나) · 미해결 동안 사이드바 slug 없음 = 못 연 프로젝트로 다시 안 감(유나).
    expect(container.querySelector('div.min-h-\\[50vh\\].px-4'), '오류 카드 좌우 여백(compact 자체 · 이중 래퍼 0)').toBeTruthy();
    expect(container.querySelector('div.px-4 > div.min-h-\\[50vh\\]'), '호출부 이중 여백 래퍼 없음').toBeNull();
    expect(sidebar.slug).toBeUndefined();
    expect(since(mark).filter((r) => r.url.startsWith('/api/stories'))).toEqual([]);
    retryMock.mockClear();
    await act(async () => { retry!.click(); });
    expect(retryMock).toHaveBeenCalledTimes(1); // 무조건 전체 이동(lib/hard-reload 단위 테스트가 저장소 막힘까지 잰다)
  });
});
