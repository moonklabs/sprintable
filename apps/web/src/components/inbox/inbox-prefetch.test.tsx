// @vitest-environment jsdom
// story #4276 — 결재 탭 데이터 요청 선출발(inbox/loading.tsx) · 넘겨받기 규칙(1회용 · 기한 10초 · 범위 · 탭) · 실제 화면이 넘겨받는지.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';

const { fetchWithAuthMock, useDashboardContextMock, searchParamsMock } = vi.hoisted(() => ({
  fetchWithAuthMock: vi.fn(),
  useDashboardContextMock: vi.fn(),
  searchParamsMock: { value: new URLSearchParams() },
}));

vi.mock('@/lib/db/client', () => ({
  fetchWithAuth: (...args: unknown[]) => fetchWithAuthMock(...args),
}));
vi.mock('@/app/dashboard/dashboard-shell', () => ({
  useDashboardContext: () => useDashboardContextMock(),
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => searchParamsMock.value,
}));
vi.mock('@/components/realtime-provider', () => ({
  useSseMultiplexerContext: () => ({ subscribe: () => () => {}, subscribeMessage: () => () => {}, subscribeReconnect: () => () => {} }),
}));

import {
  INBOX_GATES_HELD_URL,
  INBOX_GATES_PENDING_URL,
  PREFETCH_TTL_MS,
  __resetInboxPrefetchForTest,
  inboxNotificationsUrl,
  inboxWorkflowExecutionsUrl,
  prefetchInbox,
  takePrefetchedOrFetch,
} from './inbox-prefetch';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SCOPE = { memberId: 'member-1', projectId: 'project-1' };
const okJson = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
const calledUrls = () => fetchWithAuthMock.mock.calls.map((c) => String(c[0]));
const countOf = (url: string) => calledUrls().filter((u) => u === url).length;

beforeEach(() => {
  __resetInboxPrefetchForTest();
  fetchWithAuthMock.mockReset();
  fetchWithAuthMock.mockImplementation(async (url: string) => okJson(url.includes('/api/gates/inbox') ? [] : { data: [], items: [] }));
  useDashboardContextMock.mockReturnValue({
    orgMemberships: [{ orgId: 'org-1', orgName: '뭉클랩' }],
    projectMemberships: [],
    currentMemberType: 'human',
    currentTeamMemberId: SCOPE.memberId,
    projectId: SCOPE.projectId,
  });
  searchParamsMock.value = new URLSearchParams('tab=gates');
});

describe('prefetchInbox — 무엇을 먼저 출발시키나', () => {
  it('⭐결재 탭(?tab=gates): gates pending · held + 알림 1쪽 + 워크플로우 실행 — 넷', () => {
    prefetchInbox(SCOPE, 'gates', 1_000);
    expect(calledUrls().sort()).toEqual([
      INBOX_GATES_HELD_URL,
      INBOX_GATES_PENDING_URL,
      inboxNotificationsUrl(),
      inboxWorkflowExecutionsUrl('project-1', 'member-1'),
    ].sort());
  });

  it('다른 탭(알림 등)으로 오면 gates는 안 보낸다(안 쓰는 요청)', () => {
    prefetchInbox(SCOPE, 'notifications', 1_000);
    expect(countOf(INBOX_GATES_PENDING_URL)).toBe(0);
    expect(countOf(inboxNotificationsUrl())).toBe(1);
  });

  it('같은 범위 · 기한 안에 다시 부르면 다시 출발하지 않는다(StrictMode 이중 effect)', () => {
    prefetchInbox(SCOPE, 'gates', 1_000);
    prefetchInbox(SCOPE, 'gates', 1_500);
    expect(countOf(INBOX_GATES_PENDING_URL)).toBe(1);
  });
});

describe('takePrefetchedOrFetch — 넘겨받기 규칙', () => {
  it('⭐1회용: 첫 번째는 선출발 응답 그대로 · 두 번째는 새 요청', async () => {
    prefetchInbox(SCOPE, 'gates', 1_000);
    const first = await takePrefetchedOrFetch(INBOX_GATES_PENDING_URL, SCOPE, 1_200);
    expect(countOf(INBOX_GATES_PENDING_URL)).toBe(1);
    expect(first.ok).toBe(true);
    await takePrefetchedOrFetch(INBOX_GATES_PENDING_URL, SCOPE, 1_300);
    expect(countOf(INBOX_GATES_PENDING_URL)).toBe(2);
  });

  it('⭐기한(10초) 지나면 버리고 새 요청 — 화면 폴링(15초)보다 오래된 값이 서지 않게', async () => {
    prefetchInbox(SCOPE, 'gates', 1_000);
    await takePrefetchedOrFetch(INBOX_GATES_PENDING_URL, SCOPE, 1_000 + PREFETCH_TTL_MS + 1);
    expect(countOf(INBOX_GATES_PENDING_URL)).toBe(2);
    expect(PREFETCH_TTL_MS).toBeLessThan(15_000);
  });

  it('⭐범위가 다르면(그 사이 프로젝트 · 계정 전환) 버리고 새 요청', async () => {
    prefetchInbox(SCOPE, 'gates', 1_000);
    await takePrefetchedOrFetch(INBOX_GATES_PENDING_URL, { memberId: 'member-1', projectId: 'project-2' }, 1_200);
    expect(countOf(INBOX_GATES_PENDING_URL)).toBe(2);
  });

  it('선출발이 실패해도 처리 안 된 거부로 새지 않고, 넘겨받는 쪽은 그 실패를 그대로 받는다', async () => {
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    fetchWithAuthMock.mockImplementationOnce(async () => { throw new Error('network'); });
    prefetchInbox(SCOPE, 'notifications', 1_000);
    await expect(takePrefetchedOrFetch(inboxNotificationsUrl(), SCOPE, 1_100)).rejects.toThrow('network');
    await new Promise((r) => setTimeout(r, 0));
    process.off('unhandledRejection', unhandled);
    expect(unhandled).not.toHaveBeenCalled();
  });
});

describe('⭐실제 화면이 넘겨받는다 — loading의 선출발 + 결재 큐 마운트 = gates 요청 각 1건', () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('⭐inbox/loading.tsx(실제 로딩 경계)를 그리면 결재 탭 요청 넷이 출발한다', async () => {
    const { default: Loading } = await import('@/app/(authenticated)/inbox/loading');
    await act(async () => { root.render(<NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul"><Loading /></NextIntlClientProvider>); });
    expect(calledUrls().sort()).toEqual([
      INBOX_GATES_HELD_URL,
      INBOX_GATES_PENDING_URL,
      inboxNotificationsUrl(),
      inboxWorkflowExecutionsUrl('project-1', 'member-1'),
    ].sort());
  });

  it('선출발 뒤 ApprovalsQueue가 붙어도 pending · held는 각 1건(넘겨받음 — 따로 보냈으면 2건)', async () => {
    const { InboxPrefetchStarter } = await import('./inbox-prefetch-starter');
    const { ApprovalsQueue } = await import('./approvals-queue');
    await act(async () => { root.render(<NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul"><InboxPrefetchStarter /></NextIntlClientProvider>); });
    expect(countOf(INBOX_GATES_PENDING_URL)).toBe(1);
    await act(async () => { root.render(<NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul"><InboxPrefetchStarter /><ApprovalsQueue /></NextIntlClientProvider>); });
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(countOf(INBOX_GATES_PENDING_URL)).toBe(1);
    expect(countOf(INBOX_GATES_HELD_URL)).toBe(1);
  });
});
