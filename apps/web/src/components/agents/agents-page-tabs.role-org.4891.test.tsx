// @vitest-environment jsdom
//
// story 4891 — (1) «Add agent» with no project shows the create link to EVERY member whatever /api/me answers (any member may create a project — story 4897; an earlier head asked non-admins to «ask an
// admin»). (2) The person's role belongs to ONE organization: an organization switch re-renders this page without remounting it (use-unified-switcher → router.refresh), and the admin-only Access tab must
// follow the CURRENT organization — never stay open from the old one, and a late answer for an organization the person already left is dropped. The real tab is mounted with the real context states.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';

const { useDashboardContextMock, fetchMeMock } = vi.hoisted(() => ({ useDashboardContextMock: vi.fn(), fetchMeMock: vi.fn() }));
vi.mock('@/app/dashboard/dashboard-shell', () => ({ useDashboardContext: () => useDashboardContextMock() }));
vi.mock('@/lib/me-client', () => ({ fetchMe: () => fetchMeMock() }));
vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams('tab=recruit') }));
vi.mock('@/components/agents/agent-performance-panel', () => ({ AgentPerformancePanel: () => null }));
vi.mock('@/components/agents/agent-management-tab', () => ({ AgentManagementTab: () => null }));
vi.mock('@/components/agents/access-matrix-tab', () => ({ AccessMatrixTab: () => null }));
vi.mock('@/app/(authenticated)/organization/workforce/recruiter/recruiter-client', () => ({ RecruiterClient: () => null }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  fetchMeMock.mockReset();
  useDashboardContextMock.mockReturnValue(ctxFor('org-A'));
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); vi.resetModules(); });

const ctxFor = (orgId: string) => ({ projectId: null, orgId, projectMemberships: [], projectPathUnresolved: false, orgSyncPending: false, projectMembershipsFailed: false });
const answer = (role?: string) => ({ ok: true, json: async () => ({ data: role === undefined ? {} : { role } }) });
const flush = async () => { await act(async () => { for (let i = 0; i < 6; i += 1) await Promise.resolve(); }); };

async function mount() {
  const { TopBarProvider } = await import('@/components/nav/top-bar-context'); // imported after resetModules with the tab, so both share one context module
  const { AgentsPageTabs } = await import('./agents-page-tabs');
  const tree = () => <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul"><TopBarProvider><AgentsPageTabs /></TopBarProvider></NextIntlClientProvider>;
  await act(async () => { root.render(tree()); });
  await flush();
  return {
    rerender: async () => { await act(async () => { root.render(tree()); }); },
    flush,
    pane: () => ({ state: container.querySelector('[data-testid="recruit-no-project"]')?.getAttribute('data-state') ?? null, hasCreate: !!container.querySelector('[data-testid="recruit-create-project"]') }),
    accessTab: () => [...container.querySelectorAll('[role="tab"]')].some((t) => (t.textContent ?? '').trim() === koMessages.agents.accessTab),
  };
}

describe('Recruit without a project — the create link for every member, whatever /api/me answers (story 4891 · 4897)', () => {
  for (const [name, me] of [['admin', answer('admin')], ['member', answer('member')], ['no role in the answer', answer()], ['a failed request', { ok: false, json: async () => ({}) }]] as const) {
    it(`⭐${name} → create, with the link`, async () => {
      fetchMeMock.mockResolvedValue(me);
      const m = await mount();
      expect(m.pane()).toEqual({ state: 'create', hasCreate: true });
    });
  }
});

describe('the role follows the organization (story 4891, codex round 3)', () => {
  it('⭐admin in org A → the Access tab is there · switch to org B (member): gone, and never org A\'s tab while B\'s answer is out · then org C (owner): back', async () => {
    let answerB: (v: unknown) => void = () => {};
    fetchMeMock.mockResolvedValueOnce(answer('admin')).mockImplementationOnce(() => new Promise((r) => { answerB = r; })).mockResolvedValueOnce(answer('owner'));
    const m = await mount();
    expect(m.accessTab()).toBe(true);
    useDashboardContextMock.mockReturnValue(ctxFor('org-B'));
    await m.rerender(); await m.flush();
    expect(m.accessTab()).toBe(false); // B's answer is still out — never A's role for B
    await act(async () => { answerB(answer('member')); });
    await m.flush();
    expect(m.accessTab()).toBe(false);
    useDashboardContextMock.mockReturnValue(ctxFor('org-C'));
    await m.rerender(); await m.flush();
    expect(m.accessTab()).toBe(true);
  });

  it('⭐a late answer for the organization the person already left never replaces the current organization\'s role (B is an admin, A\'s late answer says member → B keeps its Access tab)', async () => {
    let lateA: (v: unknown) => void = () => {};
    fetchMeMock.mockImplementationOnce(() => new Promise((r) => { lateA = r; })).mockResolvedValueOnce(answer('admin'));
    const m = await mount();
    useDashboardContextMock.mockReturnValue(ctxFor('org-B'));
    await m.rerender(); await m.flush();
    expect(m.accessTab()).toBe(true);
    await act(async () => { lateA(answer('member')); });
    await m.flush();
    expect(m.accessTab()).toBe(true);
  });
});
