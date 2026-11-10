// @vitest-environment jsdom
//
// story #4885 («팀» 탭줄) — 바깥 «채용» 링크는 같은 화면의 쿼리(?tab=recruit)만 바꾼다. 안쪽 탭이 마운트 때만 주소를 읽으면 줄은 «채용»인데 화면은 «관리»에 머문다(codex 1판 차단).
// 되돌리면 RED: ① 주소가 바뀌어도 안쪽이 안 따라감 ② 안쪽 탭을 눌러도 주소가 안 바뀜.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { TopBarProvider } from '@/components/nav/top-bar-context';

const { useDashboardContextMock, searchRef } = vi.hoisted(() => ({ useDashboardContextMock: vi.fn(), searchRef: { current: '' } }));
vi.mock('@/app/dashboard/dashboard-shell', () => ({ useDashboardContext: () => useDashboardContextMock() }));
vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams(searchRef.current) }));
vi.mock('@/lib/db/client', () => ({ fetchWithAuth: vi.fn(async () => ({ ok: true, json: async () => ({ data: { role: 'member' } }) })) }));
vi.mock('@/components/agents/agent-performance-panel', () => ({ AgentPerformancePanel: () => <div data-pane="stats" /> }));
vi.mock('@/components/agents/agent-management-tab', () => ({ AgentManagementTab: () => <div data-pane="manage" /> }));
vi.mock('@/components/agents/access-matrix-tab', () => ({ AccessMatrixTab: () => <div data-pane="access" /> }));
vi.mock('@/app/(authenticated)/organization/workforce/recruiter/recruiter-client', () => ({ RecruiterClient: () => <div data-pane="recruit" /> }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  useDashboardContextMock.mockReturnValue({ projectId: 'proj-1', orgId: 'org-1' });
  searchRef.current = '';
  window.history.replaceState(null, '', '/organization/workforce');
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); });

async function render() {
  const { AgentsPageTabs } = await import('./agents-page-tabs');
  const tree = () => (
    <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul"><TopBarProvider><AgentsPageTabs /></TopBarProvider></NextIntlClientProvider>
  );
  await act(async () => { root.render(tree()); });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  return async () => { await act(async () => { root.render(tree()); }); await act(async () => { await Promise.resolve(); }); };
}
const pane = () => [...container.querySelectorAll('[data-pane]')].map((e) => e.getAttribute('data-pane'));

describe('AgentsPageTabs — 주소와 안쪽 탭이 같이 움직인다(story #4885)', () => {
  it('⭐주소(?tab)가 바뀌면 같은 마운트에서 안쪽 탭이 따라간다: 관리 → 채용 → (쿼리 없음) 관리', async () => {
    const rerender = await render();
    expect(pane()).toEqual(['manage']);
    searchRef.current = 'tab=recruit';
    await rerender();
    expect(pane()).toEqual(['recruit']);
    searchRef.current = '';
    await rerender();
    expect(pane()).toEqual(['manage']);
  });

  it('⭐안쪽 탭을 누르면 주소도 바뀐다(바깥 «팀» 줄의 «지금 여기»와 어긋나지 않게) · 다른 쿼리(p)는 그대로', async () => {
    // 실제 Next에선 history.state가 라우터 상태(`__NA` 등)를 들고 있다 — 코드가 그걸 그대로 넘기면 Next가 동기를 건너뛴다. 시험도 그 모양으로 시작한다.
    window.history.replaceState({ __NA: true, tree: ['', {}] }, '', '/organization/workforce?p=proj-1');
    await render();
    const recruitTab = [...container.querySelectorAll('[role="tab"]')].find((t) => t.textContent?.includes('채용')) as HTMLElement;
    expect(recruitTab).toBeTruthy();
    // Next는 state 인자에 자기 라우터 상태를 든 replaceState를 useSearchParams에 알리지 않는다 → 반드시 null(실제 dev에서 바깥 줄이 안 따라온 결함 · jsdom에선 통합이 없어 인자만 단언한다)
    const spy = vi.spyOn(window.history, 'replaceState');
    await act(async () => { recruitTab.click(); });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]![0], 'replaceState의 state 인자').toBeNull();
    spy.mockRestore();
    const sp = new URLSearchParams(window.location.search);
    expect(sp.get('tab')).toBe('recruit');
    expect(sp.get('p')).toBe('proj-1');
    expect(window.location.pathname).toBe('/organization/workforce');
    expect(pane()).toEqual(['recruit']);
  });
});
