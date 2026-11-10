// @vitest-environment jsdom
//
// story 4891 (codex, PR D) — «Add agent» with no project asks a person to turn to an admin ONLY when /api/me really said they are not one. A failed /api/me (or an answer with no role)
// leaves `isAdmin` false too, and used to read as «not an admin»: an admin on a bad moment lost the create link. The real tab is mounted here, with the real context states and the
// four answers /api/me can give; the pane's `data-state` is read.
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
  useDashboardContextMock.mockReturnValue({ projectId: null, orgId: 'org-1', projectMemberships: [], projectPathUnresolved: false, orgSyncPending: false, projectMembershipsFailed: false });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); vi.resetModules(); });

async function paneState(me: { ok: boolean; body?: unknown }) {
  fetchMeMock.mockResolvedValue({ ok: me.ok, json: async () => me.body ?? {} });
  const { TopBarProvider } = await import('@/components/nav/top-bar-context'); // imported after resetModules with the tab, so both share one context module
  const { AgentsPageTabs } = await import('./agents-page-tabs');
  await act(async () => {
    root.render(<NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul"><TopBarProvider><AgentsPageTabs /></TopBarProvider></NextIntlClientProvider>);
  });
  await act(async () => { for (let i = 0; i < 6; i += 1) await Promise.resolve(); });
  const el = container.querySelector('[data-testid="recruit-no-project"]');
  return { state: el?.getAttribute('data-state') ?? null, hasCreate: !!container.querySelector('[data-testid="recruit-create-project"]') };
}

describe('AgentsPageTabs · Recruit without a project — the person\'s role is known only from a good /api/me answer (story 4891)', () => {
  it('⭐an admin (answered) → create, with the link', async () => {
    expect(await paneState({ ok: true, body: { data: { role: 'admin' } } })).toEqual({ state: 'create', hasCreate: true });
  });
  it('a member (answered) → ask-admin, no link', async () => {
    expect(await paneState({ ok: true, body: { data: { role: 'member' } } })).toEqual({ state: 'ask-admin', hasCreate: false });
  });
  it('⭐/api/me failed (not ok) → «none» (the line only) — never «ask an admin» to a person who may be one', async () => {
    expect(await paneState({ ok: false })).toEqual({ state: 'none', hasCreate: false });
  });
  it('⭐/api/me answered with no role → «none», not «not an admin»', async () => {
    expect(await paneState({ ok: true, body: { data: {} } })).toEqual({ state: 'none', hasCreate: false });
  });
});

// An organization switch re-renders the page without remounting it (use-unified-switcher → router.refresh): the role asked for the old organization must not stand for the new one.
describe('the role follows the organization (story 4891, codex round 3)', () => {
  const ctxFor = (orgId: string) => ({ projectId: null, orgId, projectMemberships: [], projectPathUnresolved: false, orgSyncPending: false, projectMembershipsFailed: false });
  const answerFor = (role: string) => ({ ok: true, json: async () => ({ data: { role } }) });
  async function mountThen(first: string) {
    const { TopBarProvider } = await import('@/components/nav/top-bar-context');
    const { AgentsPageTabs } = await import('./agents-page-tabs');
    const tree = () => <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul"><TopBarProvider><AgentsPageTabs /></TopBarProvider></NextIntlClientProvider>;
    const flush = async () => { await act(async () => { for (let i = 0; i < 6; i += 1) await Promise.resolve(); }); };
    const state = () => container.querySelector('[data-testid="recruit-no-project"]')?.getAttribute('data-state') ?? null;
    useDashboardContextMock.mockReturnValue(ctxFor(first));
    await act(async () => { root.render(tree()); });
    await flush();
    return { tree, flush, state };
  }

  it('⭐admin in org A → switch to org B where the person is a member: ask-admin (not the old org\'s create), and the other way round', async () => {
    let answerB: (v: unknown) => void = () => {};
    fetchMeMock.mockResolvedValueOnce(answerFor('admin')).mockImplementationOnce(() => new Promise((r) => { answerB = r; })).mockResolvedValueOnce(answerFor('owner'));
    const { tree, flush, state } = await mountThen('org-A');
    expect(state()).toBe('create');
    useDashboardContextMock.mockReturnValue(ctxFor('org-B'));
    await act(async () => { root.render(tree()); });
    await flush();
    expect(state()).toBe('none'); // org B's answer is still out: its role is not known — never org A's «create»
    await act(async () => { answerB(answerFor('member')); });
    await flush();
    expect(state()).toBe('ask-admin');
    useDashboardContextMock.mockReturnValue(ctxFor('org-C'));
    await act(async () => { root.render(tree()); });
    await flush();
    expect(state()).toBe('create');
  });

  it('⭐a late answer for the organization the person already left is ignored', async () => {
    let lateA: (v: unknown) => void = () => {};
    fetchMeMock.mockImplementationOnce(() => new Promise((r) => { lateA = r; })).mockResolvedValueOnce(answerFor('member'));
    const { tree, flush, state } = await mountThen('org-A');
    useDashboardContextMock.mockReturnValue(ctxFor('org-B'));
    await act(async () => { root.render(tree()); });
    await flush();
    expect(state()).toBe('ask-admin');
    await act(async () => { lateA(answerFor('admin')); });
    await flush();
    expect(state()).toBe('ask-admin');
  });
});

