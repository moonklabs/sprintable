// @vitest-environment jsdom
//
// story 5031 (C1 step 5a · codex round 1) — the REAL publisher of the 에이전트 first screen (AgentsPageTabs) under the REAL top bar. The bug this pins: its title is a component (AgentsTopBarTitle), whose words an element scan cannot read, so the path said the place
// twice — «조직 › 에이전트 › 에이전트». A hand-made h1 title cannot show it; this is the shipped publisher (its four tab panels are stubbed, as agents-page-tabs.h1.test.tsx does).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';

const { useDashboardContextMock } = vi.hoisted(() => ({ useDashboardContextMock: vi.fn() }));
vi.mock('@/app/dashboard/dashboard-shell', () => ({ useDashboardContext: () => useDashboardContextMock() }));
vi.mock('next/navigation', () => ({
  usePathname: () => '/organization/workforce',
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));
vi.mock('@/lib/db/client', () => ({ fetchWithAuth: vi.fn(async () => ({ ok: true, json: async () => ({ data: { role: 'member' } }) })) }));
vi.mock('@/components/agents/agent-performance-panel', () => ({ AgentPerformancePanel: () => null }));
vi.mock('@/components/agents/agent-management-tab', () => ({ AgentManagementTab: () => null }));
vi.mock('@/components/agents/access-matrix-tab', () => ({ AccessMatrixTab: () => null }));
vi.mock('@/app/(authenticated)/organization/workforce/recruiter/recruiter-client', () => ({ RecruiterClient: () => null }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  useDashboardContextMock.mockReturnValue({ projectId: 'proj-1', orgId: 'org-1' });
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ data: {} }), { status: 200, headers: { 'content-type': 'application/json' } })));
  const store = new Map<string, string>();
  vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); }, removeItem: (k: string) => { store.delete(k); }, clear: () => store.clear() });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); vi.unstubAllGlobals(); vi.resetModules(); });

describe('AgentsPageTabs under the real bar (story 5031 · 5a)', () => {
  it('⭐/organization/workforce reads «조직 › 에이전트» — the place once, the title as the last item (still the page\'s one h1)', async () => {
    const { AgentsPageTabs } = await import('./agents-page-tabs');
    const { TopBar } = await import('@/components/nav/top-bar');
    const { TopBarProvider } = await import('@/components/nav/top-bar-context');
    const { SidebarProvider } = await import('@/components/ui/sidebar');
    await act(async () => {
      root.render(
        <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
          <TopBarProvider pathname="/organization/workforce"><SidebarProvider>
            <TopBar orgId="o1" orgMemberships={[{ orgId: 'o1', orgName: '올리베이라 조직', orgSlug: 'acme' }]} projectId="proj-1" projectMemberships={[]} />
            <AgentsPageTabs />
          </SidebarProvider></TopBarProvider>
        </NextIntlClientProvider>,
      );
    });
    await act(async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); });
    const items = [...container.querySelectorAll('[data-testid="top-bar-path"] li')].map((li) => li.textContent!.trim()).filter(Boolean);
    expect(items).toEqual(['올리베이라 조직', '에이전트']);
    expect(container.querySelectorAll('h1')).toHaveLength(1);
  });
});
