// @vitest-environment jsdom
//
// story #4281 — 결재 화면 머리 숫자. 예전엔 탭과 무관하게 알림의 «한 페이지(50) 안 안 읽음»이 떠 «오늘 50» · «결재함 50»으로
// 읽혔다. 이제 알림 탭에서만 · 진짜 안 읽은 수(서버 COUNT — route.ts)를 보이고, 오늘 · 결재함 탭엔 숫자를 안 붙인다(그 탭의
// 수를 이 화면이 모른다). 뮤테이션: 탭 조건을 빼면 결재함 · 오늘 경우가 RED.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { TopBarProvider, useTopBar } from '@/components/nav/top-bar-context';
import koMessages from '../../../../messages/ko.json';

const { useDashboardContextMock, searchRef } = vi.hoisted(() => ({
  useDashboardContextMock: vi.fn(),
  searchRef: { current: '' },
}));

vi.mock('@/app/dashboard/dashboard-shell', () => ({ useDashboardContext: () => useDashboardContextMock() }));
vi.mock('../../dashboard/dashboard-shell', () => ({ useDashboardContext: () => useDashboardContextMock() }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(searchRef.current),
}));
vi.mock('@/components/inbox/approvals-queue', () => ({ ApprovalsQueue: () => null }));
vi.mock('@/components/attention-queue/attention-queue-view', () => ({ AttentionQueueView: () => null }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  useDashboardContextMock.mockReturnValue({ currentTeamMemberId: 'me-1', projectId: 'proj-1' });
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.includes('/api/notifications')) {
      // 한 페이지(50)를 넘는 진짜 안 읽은 수 — route.ts가 COUNT로 싣는 값.
      return { ok: true, json: async () => ({ data: [], meta: { unreadCount: 120, hasMore: true, nextCursor: 'c' } }) };
    }
    if (url.includes('/api/workflow-executions')) return { ok: true, json: async () => ({ items: [] }) };
    return { ok: false, status: 404, json: async () => null };
  }));
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.unstubAllGlobals();
  searchRef.current = '';
});

function TopBarTitleProbe() {
  const { title } = useTopBar();
  return <div data-testid="probe">{title}</div>;
}

async function mountAt(search: string) {
  searchRef.current = search;
  const { default: InboxPage } = await import('./page');
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
        <TopBarProvider>
          <TopBarTitleProbe />
          <InboxPage />
        </TopBarProvider>
      </NextIntlClientProvider>,
    );
  });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
  return container.querySelector('[data-testid="probe"]')?.textContent ?? '';
}

describe('인박스 머리 숫자(story #4281)', () => {
  it('⭐알림 탭 — 진짜 안 읽은 수(120, 페이지 크기 50 아님)', async () => {
    expect(await mountAt('')).toContain('120');
  });

  it.each([['tab=attention'], ['tab=gates']])('⭐%s — 머리에 숫자 없음(그 탭의 수를 모른다)', async (search) => {
    const title = await mountAt(search);
    expect(title).not.toMatch(/\d/);
  });
});
