// @vitest-environment jsdom
//
// story #2195 — 인박스 기본(notifications) 탭이 서버 하드코딩 limit=50 + 커서 없음으로
// 51번째부터 조용히 잘렸다. BE(#2538, 규약 A)가 has_more/next_cursor를 body meta로 낸다 —
// FE가 "더 보기"를 세우고, 눌렀을 때 실제로 next_cursor를 다음 요청에 실어 붙이는지,
// 그리고 서버가 hasMore=false면 그 버튼이 서 있지 않는지가 이 스위트의 본체다.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { TopBarProvider } from '@/components/nav/top-bar-context';
import koMessages from '../../../../messages/ko.json';

const { useDashboardContextMock, pushMock, replaceMock } = vi.hoisted(() => ({
  useDashboardContextMock: vi.fn(),
  pushMock: vi.fn(),
  replaceMock: vi.fn(),
}));

vi.mock('@/app/dashboard/dashboard-shell', () => ({
  useDashboardContext: () => useDashboardContextMock(),
}));
vi.mock('../../dashboard/dashboard-shell', () => ({
  useDashboardContext: () => useDashboardContextMock(),
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: pushMock, replace: replaceMock }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('@/components/inbox/approvals-queue', () => ({ ApprovalsQueue: () => null }));
vi.mock('@/components/attention-queue/attention-queue-view', () => ({ AttentionQueueView: () => null }));

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
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  pushMock.mockClear();
  replaceMock.mockClear();
  useDashboardContextMock.mockReturnValue({ currentTeamMemberId: 'me-1', projectId: 'proj-1' });
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.unstubAllGlobals();
});

const NOTIF = (id: string) => ({
  id, org_id: 'o1', user_id: 'u1', type: 'x', title: `notif-${id}`, body: null,
  is_read: false, reference_type: null, reference_id: null, created_at: '2026-01-01T00:00:00+00:00',
});

function stubFetch(pages: { hasMore: boolean; nextCursor: string | null; items: unknown[] }[]) {
  let call = 0;
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (typeof url === 'string' && url.includes('/api/workflow-executions')) {
      return { ok: true, json: async () => ({ items: [] }) };
    }
    if (typeof url === 'string' && url.includes('/api/notifications')) {
      const page = pages[Math.min(call, pages.length - 1)];
      call += 1;
      return {
        ok: true,
        json: async () => ({ data: page!.items, meta: { unreadCount: page!.items.length, hasMore: page!.hasMore, nextCursor: page!.nextCursor } }),
      };
    }
    return { ok: false, status: 404, json: async () => null };
  }));
}

async function mount(Page: React.ComponentType) {
  await act(async () => {
    root.render(wrap(<Page />));
  });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
}

describe('인박스 기본 탭 커서 페이지네이션 (story #2195)', () => {
  it('hasMore=true면 "더 보기" 버튼이 뜬다', async () => {
    stubFetch([{ hasMore: true, nextCursor: '2025-12-01T00:00:00+00:00', items: [NOTIF('1'), NOTIF('2')] }]);
    const { default: InboxPage } = await import('./page');
    await mount(InboxPage);

    const loadMoreBtn = [...container.querySelectorAll('button')].find((b) => b.textContent === '더 보기');
    expect(loadMoreBtn).toBeTruthy();
  });

  it('hasMore=false면 "더 보기" 버튼이 서 있지 않는다(서버가 못 줄 때 안 보이게)', async () => {
    stubFetch([{ hasMore: false, nextCursor: null, items: [NOTIF('1')] }]);
    const { default: InboxPage } = await import('./page');
    await mount(InboxPage);

    const loadMoreBtn = [...container.querySelectorAll('button')].find((b) => b.textContent === '더 보기');
    expect(loadMoreBtn).toBeFalsy();
  });

  it('"더 보기" 클릭 시 nextCursor를 실어 다음 페이지를 요청하고, 결과를 기존 목록에 이어 붙인다', async () => {
    stubFetch([
      { hasMore: true, nextCursor: '2025-12-01T00:00:00+00:00', items: [NOTIF('1'), NOTIF('2')] },
      { hasMore: false, nextCursor: null, items: [NOTIF('3')] },
    ]);
    const { default: InboxPage } = await import('./page');
    await mount(InboxPage);

    expect(container.textContent).toContain('notif-1');
    expect(container.textContent).not.toContain('notif-3');

    const loadMoreBtn = [...container.querySelectorAll('button')].find((b) => b.textContent === '더 보기')!;
    await act(async () => { loadMoreBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    const fetchMock = vi.mocked(fetch);
    const secondCallUrl = fetchMock.mock.calls.find(([u]) =>
      typeof u === 'string' && u.includes('/api/notifications') && u.includes('cursor='),
    )?.[0] as string | undefined;
    expect(secondCallUrl).toContain(`cursor=${encodeURIComponent('2025-12-01T00:00:00+00:00')}`);

    // 이어 붙임 — 기존 항목이 사라지지 않고 새 항목이 추가된다.
    expect(container.textContent).toContain('notif-1');
    expect(container.textContent).toContain('notif-3');
    // 2페이지째는 hasMore:false라 버튼이 사라진다.
    expect([...container.querySelectorAll('button')].find((b) => b.textContent === '더 보기')).toBeFalsy();
  });
});
