// @vitest-environment jsdom
// story #4328 — 「하루 체크인」 첫 화면 요청이 **한 물결**인지(스탠드업 · 구성원을 기다린 뒤에야 활성 스프린트 · 피드백 · 미작성이 출발하던 것)
// · 스프린트 화면이 먼저 출발시킨 요청을 한 번만 넘겨받는지(같은 주소를 두 번 보내지 않음).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../../../../messages/ko.json';

const { useDashboardContextMock, fetchWithAuthMock } = vi.hoisted(() => ({ useDashboardContextMock: vi.fn(), fetchWithAuthMock: vi.fn() }));
vi.mock('@/app/dashboard/dashboard-shell', () => ({ useDashboardContext: () => useDashboardContextMock() }));
vi.mock('@/components/nav/top-bar-slot', () => ({ TopBarSlot: () => null }));
vi.mock('@/components/standup/board-bridge-modal', () => ({ BoardBridgeModal: () => null }));
vi.mock('@/components/standup/standup-history-section', () => ({ StandupHistorySection: () => null }));
vi.mock('@/lib/db/client', async (orig) => ({ ...(await orig<Record<string, unknown>>()), fetchWithAuth: fetchWithAuthMock }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let container: HTMLDivElement;
let root: Root;

beforeEach(async () => {
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
  useDashboardContextMock.mockReturnValue({ currentTeamMemberId: 'me-1', projectMemberships: [] });
  (await import('@/components/sprints/sprint-screen-prefetch')).__resetSprintScreenPrefetchForTest();
});
afterEach(async () => {
  await act(async () => { root.unmount(); }); container.remove();
  fetchWithAuthMock.mockReset();
});

const ENDPOINTS = ['/api/standup?date=', '/api/team-members', '/api/sprints?project_id=proj-1&status=active', '/api/standup/feedback?', '/api/standup/missing?'];

async function mount() {
  const { default: StandupPage } = await import('./standup-client');
  await act(async () => {
    root.render(<NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul"><StandupPage projectId="proj-1" embedded /></NextIntlClientProvider>);
  });
  for (let i = 0; i < 4; i += 1) await act(async () => { await Promise.resolve(); });
}

describe('「하루 체크인」 첫 화면 요청 물결(story #4328)', () => {
  it('⭐응답이 하나도 안 온 사이에 다섯 요청이 모두 출발한다(앞 둘을 기다리지 않는다)', async () => {
    fetchWithAuthMock.mockImplementation(() => new Promise(() => {})); // 백엔드가 아직 답하지 않음
    await mount();
    const urls = fetchWithAuthMock.mock.calls.map((c) => String(c[0]));
    for (const e of ENDPOINTS) expect(urls.some((u) => u.startsWith(e)), `${e} 출발`).toBe(true);
  });

  it('⭐스프린트 화면이 먼저 출발시킨 요청을 넘겨받는다 — 같은 주소를 두 번 보내지 않는다', async () => {
    fetchWithAuthMock.mockImplementation(() => new Promise(() => {}));
    const { prefetchSprintScreen } = await import('@/components/sprints/sprint-screen-prefetch');
    prefetchSprintScreen({ memberId: 'me-1', projectId: 'proj-1' });
    const afterPrefetch = fetchWithAuthMock.mock.calls.length;
    expect(afterPrefetch).toBe(7); // 스프린트 목록 + 다섯 + 스탠드업 기록
    await mount();
    const urls = fetchWithAuthMock.mock.calls.map((c) => String(c[0]));
    for (const e of ENDPOINTS) expect(urls.filter((u) => u.startsWith(e)).length, `${e} 한 번만`).toBe(1);
  });

  it('범위가 다르면(다른 사람) 넘겨받지 않고 새로 요청한다', async () => {
    fetchWithAuthMock.mockImplementation(() => new Promise(() => {}));
    const { prefetchSprintScreen } = await import('@/components/sprints/sprint-screen-prefetch');
    prefetchSprintScreen({ memberId: 'someone-else', projectId: 'proj-1' });
    await mount();
    const urls = fetchWithAuthMock.mock.calls.map((c) => String(c[0]));
    expect(urls.filter((u) => u.startsWith('/api/team-members')).length).toBe(2);
  });
});
