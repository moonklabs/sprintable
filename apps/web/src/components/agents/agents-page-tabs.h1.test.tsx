// @vitest-environment jsdom
//
// story #3946(규칙: 「TopBarSlot 제목은 그 화면에 다른 제목이 없을 때만 h1」) — 이 화면은
// 본문에 별도 마스트헤드가 없어(3946 AC1 실측) TopBarSlot의 h1이 그대로 유일한 h1이다.
// 별도 파일인 이유 — agents-page-tabs.test.tsx 자신의 주석대로 전체 컴포넌트 마운트는
// 4탭 자식(성능 패널·관리·채용·접근권한)까지 끌어와 무거워 그 파일은 의도적으로 순수
// 판정 로직(resolveTab)만 검증한다. h1 불변식 확인은 그 4자식을 목업으로 대체해 좁게
// 한 번만 마운트한다.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { TopBarProvider, useTopBar } from '@/components/nav/top-bar-context';

const { useDashboardContextMock } = vi.hoisted(() => ({ useDashboardContextMock: vi.fn() }));

vi.mock('@/app/dashboard/dashboard-shell', () => ({ useDashboardContext: () => useDashboardContextMock() }));
vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams() }));
vi.mock('@/lib/db/client', () => ({
  fetchWithAuth: vi.fn(async () => ({ ok: true, json: async () => ({ data: { role: 'member' } }) })),
}));
vi.mock('@/components/agents/agent-performance-panel', () => ({ AgentPerformancePanel: () => null }));
vi.mock('@/components/agents/agent-management-tab', () => ({ AgentManagementTab: () => null }));
vi.mock('@/components/agents/access-matrix-tab', () => ({ AccessMatrixTab: () => null }));
vi.mock('@/app/(authenticated)/organization/workforce/recruiter/recruiter-client', () => ({ RecruiterClient: () => null }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

function wrap(node: React.ReactNode) {
  return (
    <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
      <TopBarProvider>{node}</TopBarProvider>
    </NextIntlClientProvider>
  );
}

beforeEach(() => {
  useDashboardContextMock.mockReturnValue({ projectId: 'proj-1', orgId: 'org-1' });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.resetModules();
});

function TopBarTitleProbe() {
  const { title } = useTopBar();
  return <div>{title}</div>;
}

describe('AgentsPageTabs — 페이지 h1 1개(story #3946)', () => {
  it('⭐h1이 정확히 1개다(TopBarSlot 제목)', async () => {
    const { AgentsPageTabs } = await import('./agents-page-tabs');
    await act(async () => { root.render(wrap(<><TopBarTitleProbe /><AgentsPageTabs /></>)); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(container.querySelectorAll('h1')).toHaveLength(1);
  });
});
