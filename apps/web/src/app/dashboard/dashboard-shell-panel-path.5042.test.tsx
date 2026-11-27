// @vitest-environment jsdom
//
// story 5042 (C9) — a page of the desktop app's work panel (`/desktop/panel/…`) is one small view inside the app window: the shell keeps its providers (the person · the org · the project) and draws ONLY the page — none of
// the web's own frame (sidebar · icon rail · top bar · mobile tab bar · bottom dock · session-expired dialog). Every other address keeps the whole frame (the same shell, the same mocks).
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { act, type ReactNode, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const drawn = vi.hoisted(() => new Set<string>());
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
const rail = { slug: undefined as string | undefined, listColumn: undefined as { open: boolean; onToggle: () => void } | undefined };
// story #4885 — the home model provider (inside the shell) reads the live stream handle; this test has none
vi.mock('@/components/realtime-provider', () => ({ RealtimeProvider: pass, useSseMultiplexerContext: () => null }));
vi.mock('@/components/auth/session-expired-dialog', () => ({ SessionExpiredDialog: () => { drawn.add('session-expired'); return null; } }));
vi.mock('@/components/ui/toast', () => ({ ToastProvider: pass }));
vi.mock('@/components/nav/bottom-dock', () => ({ BottomDock: () => { drawn.add('bottom-dock'); return null; } }));
vi.mock('@/components/nav/app-sidebar', () => ({
  AppSidebar: (p: { currentProjectSlug?: string }) => { sidebar.slug = p.currentProjectSlug; drawn.add('sidebar'); return null; },
}));
// story #4885 B 셸 — 아이콘 막대도 같은 slug를 받는다(못 푼 경로면 막대도 못 연 프로젝트로 다시 안 보냄).
vi.mock('@/components/nav/nav-rail', () => ({
  NavRail: (p: { projectSlug?: string; listColumn?: { open: boolean; onToggle: () => void } }) => { rail.slug = p.projectSlug; rail.listColumn = p.listColumn; drawn.add('nav-rail'); return null; },
}));
vi.mock('@/components/nav/mobile-tab-bar', () => ({ MobileTabBar: () => { drawn.add('mobile-tab-bar'); return null; } }));
vi.mock('@/components/nav/top-bar', () => ({ TopBar: () => { drawn.add('top-bar'); return null; } }));
vi.mock('@/components/nav/top-bar-context', () => ({ TopBarProvider: pass, useTopBar: () => ({ setScrollContainer: () => {} }) }));
// story #4885 B 셸 — 목록 칸(길잡이) 열림은 셸이 쥔다: SidebarProvider가 받은 open / onOpenChange를 기록한다.
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


(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ORG = 'org-1';
const A = 'proj-alpha';
const serverProps = {
  currentTeamMemberId: 'tm-1', orgId: ORG, projectId: A, projectName: 'Project Alpha', currentProjectSlug: 'alpha',
  projectMemberships: [{ projectId: A, projectName: 'Project Alpha', projectSlug: 'alpha', orgId: ORG }], orgMemberships: [{ orgId: ORG, orgName: 'Repro', orgSlug: 'repro' }],
  pathOrgId: ORG, pathProjectId: A, jwtOrgId: ORG, serverResolvedPath: '/repro/alpha/flow',
};
let root: Root; let container: HTMLDivElement;
const ctxSeen: Array<{ orgId?: string; projectId?: string; inShell?: boolean }> = [];
beforeAll(() => {
  window.fetch = (async () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch;
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
});
afterAll(() => { container.remove(); });

async function renderAt(pathname: string, overrides: Partial<typeof serverProps> = {}) {
  nav.pathname = pathname; drawn.clear(); ctxSeen.length = 0;
  const { DashboardShell, useDashboardContext } = await import('./dashboard-shell');
  function Page() {
    const ctx = useDashboardContext();
    useEffect(() => { ctxSeen.push({ orgId: ctx.orgId, projectId: ctx.projectId, inShell: ctx.inShell }); });
    return <p data-testid="page">page</p>;
  }
  await act(async () => { root.render(<DashboardShell {...serverProps} {...overrides}><Page key={pathname} /></DashboardShell>); });
  await act(async () => { for (let i = 0; i < 4; i++) await Promise.resolve(); });
}
const FRAME = ['sidebar', 'nav-rail', 'top-bar', 'mobile-tab-bar', 'bottom-dock', 'session-expired'];

describe('[SID:5042] the shell at the desktop app\'s panel addresses', () => {
  it('⭐/desktop/panel/… draws the page and NONE of the web\'s frame — and the page still has the person\'s context (org · project), outside the shell\'s own frame (inShell false)', async () => {
    await renderAt('/desktop/panel/work-item/7e0e7cc1-c2b8-4669-bfaa-3b13903fd670', { pathOrgId: undefined as unknown as string, pathProjectId: undefined as unknown as string, serverResolvedPath: undefined as unknown as string });
    expect(container.querySelector('[data-testid="page"]')).not.toBeNull();
    expect([...drawn].filter((d) => FRAME.includes(d))).toEqual([]);
    expect(ctxSeen.at(-1)).toMatchObject({ orgId: ORG, inShell: false });
  });
  it('⭐every other address keeps the whole frame (a scoped page · /desktop/updates is not a panel)', async () => {
    await renderAt('/repro/alpha/flow');
    expect(container.querySelector('[data-testid="page"]')).not.toBeNull();
    for (const part of ['sidebar', 'nav-rail', 'bottom-dock']) expect(drawn.has(part), part).toBe(true);
    expect(ctxSeen.at(-1)).toMatchObject({ inShell: true });
    await renderAt('/desktop/updates/macos.json', { pathOrgId: undefined as unknown as string, pathProjectId: undefined as unknown as string, serverResolvedPath: undefined as unknown as string });
    expect(drawn.has('sidebar')).toBe(true);
  });
});
