// @vitest-environment jsdom
//
// [SID:4388] The inbox tabs (오늘 · 알림 · 결재함) showed the open one only by its underline. Each tab changes the address
// (?tab=…), so the open one now carries aria-current="page" and the others carry none.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { TopBarProvider } from '@/components/nav/top-bar-context';
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

async function mountAt(search: string) {
  searchRef.current = search;
  const { default: InboxPage } = await import('./page');
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
        <TopBarProvider>
          <InboxPage />
        </TopBarProvider>
      </NextIntlClientProvider>,
    );
  });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
}

const LABEL = {
  attention: koMessages.inbox.attentionTabLabel,
  notifications: koMessages.inbox.notificationsTabLabel,
  gates: koMessages.cage.gateTabLabel,
};

describe('[SID:4388] inbox tabs mark the open tab with aria-current="page"', () => {
  it.each([
    ['', 'notifications'],
    ['tab=attention', 'attention'],
    ['tab=gates', 'gates'],
  ] as const)('address «%s» → only the «%s» tab is current', async (search, key) => {
    await mountAt(search);
    const tabButtons = Object.values(LABEL).map((label) => [...container.querySelectorAll('button')].find((b) => b.textContent?.startsWith(label))!);
    expect(tabButtons.every(Boolean)).toBe(true);
    expect(tabButtons.map((b) => b.getAttribute('aria-current'))).toEqual(
      (Object.keys(LABEL) as (keyof typeof LABEL)[]).map((k) => (k === key ? 'page' : null)),
    );
  });
});
