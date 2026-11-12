// @vitest-environment jsdom
//
// story 4912 D6 — the Statistics tab opened without a project stayed on «퍼포먼스 데이터를 불러오는 중…» for good (the panel only loads for a project and the page only guarded the Recruit tab).
// Now the page shows the Recruit tab's no-project notice instead of the panel. The real tab is mounted with the real context states.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';

const { useDashboardContextMock, fetchMeMock } = vi.hoisted(() => ({ useDashboardContextMock: vi.fn(), fetchMeMock: vi.fn() }));
vi.mock('@/app/dashboard/dashboard-shell', () => ({ useDashboardContext: () => useDashboardContextMock() }));
vi.mock('@/lib/me-client', () => ({ fetchMe: () => fetchMeMock() }));
vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams('tab=stats'), useRouter: () => ({ push: vi.fn(), replace: vi.fn() }) }));
vi.mock('@/components/agents/agent-performance-panel', () => ({ AgentPerformancePanel: () => <div data-testid="stats-panel" /> }));
vi.mock('@/components/agents/agent-management-tab', () => ({ AgentManagementTab: () => null }));
vi.mock('@/components/agents/access-matrix-tab', () => ({ AccessMatrixTab: () => null }));
vi.mock('@/app/(authenticated)/organization/workforce/recruiter/recruiter-client', () => ({ RecruiterClient: () => null }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
const ctx = (projectId: string | null, extra: Record<string, unknown> = {}) => ({ projectId, orgId: 'org-A', projectMemberships: [], projectPathUnresolved: false, orgSyncPending: false, projectMembershipsFailed: false, ...extra });
beforeEach(() => {
  fetchMeMock.mockResolvedValue({ ok: true, json: async () => ({ data: { role: 'member' } }) });
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); vi.resetModules(); });

async function mount() {
  const { TopBarProvider } = await import('@/components/nav/top-bar-context');
  const { AgentsPageTabs } = await import('./agents-page-tabs');
  await act(async () => { root.render(<NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul"><TopBarProvider><AgentsPageTabs /></TopBarProvider></NextIntlClientProvider>); });
  await act(async () => { for (let i = 0; i < 6; i += 1) await Promise.resolve(); });
}
const notice = () => container.querySelector('[data-testid="recruit-no-project"]');

describe('Statistics tab without a project (story 4912 D6)', () => {
  it('⭐no project at all → the no-project notice with the create link, and NO stats panel (which would sit on «불러오는 중…»)', async () => {
    useDashboardContextMock.mockReturnValue(ctx(null));
    await mount();
    expect(notice()?.getAttribute('data-state')).toBe('create');
    expect(container.querySelector('[data-testid="recruit-create-project"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="stats-panel"]')).toBeNull();
    expect(container.textContent).not.toContain(koMessages.agents.scopeThisProject);
  });

  it('⭐projects exist but none is chosen → the «pick one» notice, no panel', async () => {
    useDashboardContextMock.mockReturnValue(ctx(null, { projectMemberships: [{ project_id: 'p1' }] }));
    await mount();
    expect(notice()?.getAttribute('data-state')).toBe('pick');
    expect(container.querySelector('[data-testid="stats-panel"]')).toBeNull();
  });

  it('⭐the projects request failed → the «could not load» notice with [try again], no panel', async () => {
    useDashboardContextMock.mockReturnValue(ctx(null, { projectMembershipsFailed: true }));
    await mount();
    expect(notice()?.getAttribute('data-state')).toBe('failed');
    expect(container.querySelector('[data-testid="stats-panel"]')).toBeNull();
  });

  it('with a project the panel and the «이 프로젝트» badge are there, no notice (the normal path is unchanged)', async () => {
    useDashboardContextMock.mockReturnValue(ctx('p1'));
    await mount();
    expect(container.querySelector('[data-testid="stats-panel"]')).toBeTruthy();
    expect(container.textContent).toContain(koMessages.agents.scopeThisProject);
    expect(notice()).toBeNull();
  });
});
