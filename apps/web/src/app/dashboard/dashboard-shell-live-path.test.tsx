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
vi.mock('next/navigation', () => ({
  usePathname: () => nav.pathname,
  useSearchParams: () => new URLSearchParams(nav.search),
  useRouter: () => ({ replace: (u: string) => { nav.search = u.split('?')[1] ?? ''; }, push: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
}));
vi.mock('next-intl', () => ({ useTranslations: () => (k: string) => k }));

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
  { projectId: A, projectName: 'Project Alpha', projectSlug: 'alpha' },
  { projectId: B, projectName: 'Project Beta', projectSlug: 'beta' },
  { projectId: C, projectName: 'Project Charlie', projectSlug: 'charlie' },
];
// 서버 prop — 하드 로드 B 때 값 그대로(공유 레이아웃이라 클라이언트 이동에서 바뀌지 않는다). 세션 프로젝트는 A.
const serverProps = {
  currentTeamMemberId: 'tm-1', orgId: ORG, projectId: A, projectName: 'Project Beta', currentProjectSlug: 'beta',
  projectMemberships: memberships, orgMemberships: [{ orgId: ORG, orgName: 'Repro', orgSlug: 'repro' }],
  pathOrgId: ORG, pathProjectId: B, jwtOrgId: ORG,
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

async function renderShellAt(pathname: string) {
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
    root.render(<DashboardShell {...serverProps}><Page key={pathname} /></DashboardShell>);
  });
  await act(async () => { for (let i = 0; i < 4; i++) await Promise.resolve(); });
}

const since = (n: number) => sent.slice(n);

describe('셸 현재 프로젝트 = 현재 pathname · 인터셉터 ref = 셸 수명(story #4217)', () => {
  it('하드 B → 클라이언트 이동 C(서버 prop은 B에 고정) → 컨텍스트·이름·사이드바 slug·읽기 헤더·쓰기 project_id 전부 C', async () => {
    await renderShellAt('/repro/beta/flow');
    expect(seen.at(-1)?.projectId).toBe(B);

    const mark = sent.length;
    await renderShellAt('/repro/charlie/flow');
    expect(seen.at(-1)).toEqual({ name: 'Project Charlie', projectId: C });
    expect(sidebar.slug).toBe('charlie');
    const after = since(mark);
    expect(after.length).toBeGreaterThanOrEqual(2);
    for (const r of after) expect(r.project, r.url).toBe(C);
    // ⭐쓰기 — C 화면에서 만든 스토리가 C로(수정 전 로컬 실측은 B에 저장).
    const write = after.find((r) => r.body);
    expect(write?.body?.project_id).toBe(C);
    expect(new URLSearchParams(nav.search).get('p')).toBe(C);
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
});
