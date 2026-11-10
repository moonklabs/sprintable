// @vitest-environment jsdom
//
// story 4889 (UI-6 · W1~W6) — 에이전트 화면 안의 두 번째 탭줄이 «팀» 탭줄로 합쳐졌다. 이 화면은 **주소의 ?tab=이 유일한 진실**이다: 패널 하나만 그리고, 탭줄은 더 이상 안 그리며(팀 줄이 맡는다),
// 옛 `?tab=manage` · 탭 없는 주소 · 모르는 값은 «관리»(= 팀 줄의 «에이전트»)로 열린다. 되돌리면 빨갛다.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';

const { tabRef, pushMock, adminRef, onAddRef, onExitRef } = vi.hoisted(() => ({
  tabRef: { current: null as string | null },
  pushMock: vi.fn(),
  adminRef: { current: { isAdmin: true, loaded: true } },
  onAddRef: { current: (() => {}) as () => void },
  onExitRef: { current: (() => {}) as () => void },
}));
vi.mock('@/app/dashboard/dashboard-shell', () => ({ useDashboardContext: () => ({ projectId: 'proj-1', orgId: 'org-1', projectMemberships: [] }) }));
vi.mock('@/hooks/use-org-admin', () => ({ useOrgAdmin: () => adminRef.current }));
vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(tabRef.current === null ? '' : `tab=${tabRef.current}`),
  useRouter: () => ({ push: pushMock, replace: vi.fn() }),
}));
vi.mock('@/components/agents/agent-performance-panel', () => ({ AgentPerformancePanel: () => <div data-testid="panel-stats" /> }));
vi.mock('@/components/agents/agent-management-tab', () => ({ AgentManagementTab: ({ onAddAgent }: { onAddAgent: () => void }) => { onAddRef.current = onAddAgent; return <div data-testid="panel-manage" />; } }));
vi.mock('@/components/agents/access-matrix-tab', () => ({ AccessMatrixTab: () => <div data-testid="panel-access" /> }));
vi.mock('@/app/(authenticated)/organization/workforce/recruiter/recruiter-client', () => ({ RecruiterClient: ({ onExit }: { onExit: () => void }) => { onExitRef.current = onExit; return <div data-testid="panel-recruit" />; } }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
beforeEach(() => { tabRef.current = null; adminRef.current = { isAdmin: true, loaded: true }; pushMock.mockReset(); container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); });
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); vi.resetModules(); });

async function mount() {
  const { TopBarProvider } = await import('@/components/nav/top-bar-context');
  const { AgentsPageTabs } = await import('./agents-page-tabs');
  await act(async () => { root.render(<NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul"><TopBarProvider><AgentsPageTabs /></TopBarProvider></NextIntlClientProvider>); });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}
const panels = () => [...container.querySelectorAll('[data-testid^="panel-"]')].map((e) => e.getAttribute('data-testid')!.replace('panel-', ''));

describe('에이전트 화면 — 주소의 ?tab=이 유일한 진실 · 탭줄은 «팀» 줄 하나(story 4889)', () => {
  it('⭐안쪽 탭줄이 없다 — 이 화면은 tablist를 그리지 않는다(되돌리면 «두 줄»로 돌아가 빨갛다)', async () => {
    await mount();
    expect(container.querySelector('[role="tablist"]')).toBeNull();
    expect(container.querySelector('[role="tab"]')).toBeNull();
  });

  const CASES: Array<[string | null, string[], string]> = [
    [null, ['manage'], '탭 없는 주소'],
    ['manage', ['manage'], '⭐옛 `?tab=manage`(북마크 · 알림 링크 · 문서 속 주소)는 «에이전트»(관리 패널)로 열린다'],
    ['bogus', ['manage'], '모르는 값'],
    ['stats', ['stats'], '통계'],
    ['recruit', ['recruit'], '채용'],
    ['access', ['access'], '접근권한(관리자)'],
  ];
  it.each(CASES)('?tab=%s → 패널 %j (%s)', async (tab, want) => {
    tabRef.current = tab;
    await mount();
    expect(panels()).toEqual(want);
  });

  it('⭐일반 구성원이 ?tab=access로 오면 통계 패널로 읽는다(관리자 전용 패널은 안 열린다) · 역할 답이 오기 전엔 빈 본문(관리자 패널이 먼저 열리지 않는다)', async () => {
    tabRef.current = 'access';
    adminRef.current = { isAdmin: false, loaded: true };
    await mount();
    expect(panels()).toEqual(['stats']);
    await act(async () => { root.unmount(); });
    container.remove();
    container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
    adminRef.current = { isAdmin: false, loaded: false };
    await mount();
    expect(panels()).toEqual([]);
  });

  it('⭐«에이전트 추가»는 진짜 이동이다 — 채용 탭의 주소(?tab=recruit)로 push(예전 replaceState 갈래 없음)', async () => {
    await mount();
    await act(async () => { onAddRef.current(); });
    expect(pushMock).toHaveBeenCalledWith(expect.stringContaining('/organization/workforce?tab=recruit'));
  });

  it('⭐채용을 나가면 ?tab=manage로 push — 팀 줄의 «에이전트»가 켜지는 주소', async () => {
    tabRef.current = 'recruit';
    await mount();
    await act(async () => { onExitRef.current(); });
    expect(pushMock).toHaveBeenCalledWith(expect.stringContaining('/organization/workforce?tab=manage'));
  });
});
