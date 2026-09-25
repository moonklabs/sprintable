// @vitest-environment jsdom
// story #4295 — 결재함 알림 목록: fetchInboxNotifications에 예외 처리가 없어 망 오류 · 깨진 JSON이면 load()가 던지고 setLoading(false)가
// 안 불려 «불러오는 중»이 영원히 · «더 보기»도 loadingMore가 true로 막혔다. 읽음 처리도 응답을 안 봐 실패해도 화면은 «읽음».
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { TopBarProvider } from '@/components/nav/top-bar-context';
import koMessages from '../../../../messages/ko.json';

const { useDashboardContextMock, addToastMock } = vi.hoisted(() => ({
  useDashboardContextMock: vi.fn(),
  addToastMock: vi.fn(),
}));

vi.mock('@/app/dashboard/dashboard-shell', () => ({ useDashboardContext: () => useDashboardContextMock() }));
vi.mock('../../dashboard/dashboard-shell', () => ({ useDashboardContext: () => useDashboardContextMock() }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('@/components/inbox/approvals-queue', () => ({ ApprovalsQueue: () => null }));
vi.mock('@/components/attention-queue/attention-queue-view', () => ({ AttentionQueueView: () => null }));
vi.mock('@/components/ui/toast', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/ui/toast')>();
  return { ...actual, useToast: () => ({ addToast: addToastMock, toasts: [], dismissToast: () => {} }) };
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

const NOTIF = (id: string) => ({
  id, org_id: 'o1', user_id: 'u1', type: 'x', title: `notif-${id}`, body: null,
  is_read: false, reference_type: null, reference_id: null, created_at: '2026-01-01T00:00:00+00:00',
});
const okPage = (items: unknown[], hasMore = false, nextCursor: string | null = null) => ({
  ok: true, status: 200, json: async () => ({ data: items, meta: { unreadCount: items.length, hasMore, nextCursor } }),
});

/** 알림 GET은 순서대로 behaviors를 쓰고(마지막 것을 반복), PATCH(읽음)은 patchOk, 나머지는 빈 성공. */
function stubFetch(behaviors: Array<'network' | 'badJson' | 'notOk' | ReturnType<typeof okPage>>, patchOk = true) {
  let call = 0;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url.includes('/api/notifications') && init?.method === 'PATCH') {
      if (!patchOk) throw new TypeError('Failed to fetch');
      return { ok: true, status: 200, json: async () => ({}) };
    }
    if (url.includes('/api/notifications')) {
      const b = behaviors[Math.min(call, behaviors.length - 1)]!;
      call += 1;
      if (b === 'network') throw new TypeError('Failed to fetch');
      if (b === 'badJson') return { ok: true, status: 200, json: async () => { throw new SyntaxError('Unexpected token <'); } };
      if (b === 'notOk') return { ok: false, status: 502, json: async () => null };
      return b;
    }
    return { ok: true, status: 200, json: async () => ({ items: [] }) };
  }));
}

async function mount() {
  const { default: InboxPage } = await import('./page');
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
        <TopBarProvider><InboxPage /></TopBarProvider>
      </NextIntlClientProvider>,
    );
  });
  await act(async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); });
}

const errorBox = () => container.querySelector('[data-testid="inbox-notifications-load-error"]');
const buttonByText = (text: string) => [...container.querySelectorAll('button')].find((b) => b.textContent === text);
const skeletonCount = () => container.querySelectorAll('.animate-pulse').length;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  addToastMock.mockReset();
  useDashboardContextMock.mockReturnValue({ currentTeamMemberId: 'me-1', projectId: 'proj-1' });
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.unstubAllGlobals();
});

describe('알림 첫 쪽을 못 불러오면 — 영원히 «불러오는 중»이 아니라 실패 + 다시 시도(story #4295)', () => {
  for (const kind of ['network', 'badJson', 'notOk'] as const) {
    it(`⭐${kind}: 로딩이 끝나고 실패 표시 · «알림 없음»(거짓 0건) 아님`, async () => {
      stubFetch([kind]);
      await mount();
      expect(skeletonCount()).toBe(0);
      expect(errorBox()?.textContent).toContain(koMessages.inbox.notificationsLoadError);
      expect(container.textContent).not.toContain(koMessages.inbox.noNotifications);
    });
  }

  it('«다시 시도»로 다시 불러오면 목록이 선다', async () => {
    stubFetch(['network', okPage([NOTIF('1')])]);
    await mount();
    expect(errorBox()).toBeTruthy();
    await act(async () => { buttonByText(koMessages.common.retry)!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await act(async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); });
    expect(errorBox()).toBeNull();
    expect(container.textContent).toContain('notif-1');
  });
});

describe('«더 보기» 실패 — 버튼이 막히지 않고 알림(story #4295)', () => {
  it('⭐망 오류여도 버튼이 다시 눌리는 상태로 돌아오고 «더 불러오지 못했어요»', async () => {
    stubFetch([okPage([NOTIF('1')], true, '2025-12-01T00:00:00+00:00'), 'network']);
    await mount();
    const more = buttonByText(koMessages.common.loadMore)!;
    await act(async () => { more.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await act(async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); });
    expect(buttonByText(koMessages.common.loadMore)?.hasAttribute('disabled')).toBe(false);
    expect(addToastMock).toHaveBeenCalledWith({ title: koMessages.inbox.loadMoreFailed, type: 'error' });
    expect(container.textContent).toContain('notif-1');
  });
});

describe('읽음 처리 실패 — 화면을 «읽음»으로 바꾸지 않고 알림(story #4295 · 벨과 같은 문구)', () => {
  it('⭐알림을 눌러 읽음 처리가 망 오류면 안 읽음 수 그대로 · «읽음 처리에 실패했어요»(처리 안 된 거부 없음)', async () => {
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    stubFetch([okPage([NOTIF('1'), NOTIF('2')])], false);
    await mount();
    const row = [...container.querySelectorAll('button, [role="button"], a, div')].find((e) => e.textContent?.trim() === 'notif-1' || (e.textContent?.includes('notif-1') && e.getAttribute('role') === 'button'))
      ?? [...container.querySelectorAll('*')].reverse().find((e) => e.textContent?.includes('notif-1') && (e as HTMLElement).onclick !== undefined);
    expect(row, '알림 행').toBeTruthy();
    const clickable = (row as HTMLElement).closest('button, [role="button"]') ?? row!;
    await act(async () => { clickable.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await act(async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); });
    await new Promise((r) => setTimeout(r, 0));
    process.off('unhandledRejection', unhandled);
    expect(addToastMock).toHaveBeenCalledWith({ title: koMessages.inbox.markReadFailed, type: 'error' });
    expect(unhandled).not.toHaveBeenCalled();
  });
});
