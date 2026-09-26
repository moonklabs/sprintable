// @vitest-environment jsdom
// story #4295 — 결재함 알림 목록: fetchInboxNotifications에 예외 처리가 없어 망 오류 · 깨진 JSON이면 load()가 던지고 setLoading(false)가
// 안 불려 «불러오는 중»이 영원히 · «더 보기»도 loadingMore가 true로 막혔다. 읽음 처리도 응답을 안 봐 실패해도 화면은 «읽음».
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, StrictMode } from 'react';
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
function stubFetch(behaviors: Array<'network' | 'badJson' | 'notOk' | ReturnType<typeof okPage>>, patchOk = true, patchFailIds: string[] = []) {
  let call = 0;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url.includes('/api/notifications') && init?.method === 'PATCH') {
      if (!patchOk) throw new TypeError('Failed to fetch');
      const id = (JSON.parse(String(init.body)) as { id?: string }).id;
      if (id && patchFailIds.includes(id)) return { ok: false, status: 500, json: async () => null };
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
    expect(addToastMock).toHaveBeenCalledWith({ title: koMessages.common.loadMoreFailed, type: 'error' });
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

// story #4295(PO 검토) — 묶음을 열면 안 읽은 알림마다 읽음 처리를 부르는데, 건마다 토스트면 묶음 크기만큼(generic은 121건까지) 쏟아졌다.
describe('묶음 열기 — 읽음 실패 토스트는 한 번(story #4295 PO 검토)', () => {
  it('⭐묶음 3건 중 2건 실패 → 토스트 1번 · 요청 3건', async () => {
    const statusNotif = (id: string) => ({
      id, org_id: 'o1', user_id: 'u1', type: 'story_status_changed', title: '묶음 알림', body: null,
      is_read: false, reference_type: 'story', reference_id: 'st-1', href: null, created_at: '2026-01-01T00:00:00+00:00',
    });
    stubFetch([okPage([statusNotif('s1'), statusNotif('s2'), statusNotif('s3')])], true, ['s1', 's2']);
    await mount();
    const header = [...container.querySelectorAll('button, [role="button"]')].find((b) => b.textContent?.includes('묶음 알림') && !b.getAttribute('aria-label')?.includes('펼치기'));
    expect(header, '묶음 머리').toBeTruthy();
    await act(async () => { header!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await act(async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); });
    const patches = vi.mocked(fetch).mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === 'PATCH');
    expect(patches).toHaveLength(3);
    expect(addToastMock.mock.calls.filter(([arg]) => (arg as { title: string }).title === koMessages.inbox.markReadFailed)).toHaveLength(1);
  });
});

// story #4295 × #4276(까디르 렌즈) — loading에서 먼저 출발시킨 1쪽 요청이 실패해도 화면은 영원히 로딩이 아니다.
// story #4328(까디르 4694 ②) — 규칙이 바뀌었다: 실패한 선출발은 넘기지 않고 버린다 → 화면이 제 요청을 **한 번** 한다(선출발은 없을 때보다
// 나빠지면 안 된다 · 화면 열기 직전 일시 실패를 그대로 받지 않게). 제 요청도 실패하면 같은 실패 상자.
describe('선출발이 실패하면 화면이 제 요청을 한 번(story #4295 × #4276 · 4328)', () => {
  const notifCalls = () => vi.mocked(fetch).mock.calls.filter(([u, init]) => String(u).includes('/api/notifications') && (init as RequestInit | undefined)?.method !== 'PATCH');

  it('⭐선출발 요청이 망 오류 → 화면이 제 요청 1회 → 성공이면 목록(실패 상자 없음)', async () => {
    stubFetch(['network', okPage([NOTIF('1')])]);
    const { prefetchInbox, __resetInboxPrefetchForTest } = await import('@/components/inbox/inbox-prefetch');
    __resetInboxPrefetchForTest();
    prefetchInbox({ memberId: 'me-1', projectId: 'proj-1' }, 'notifications');
    await mount();
    await act(async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); });
    expect(errorBox()).toBeNull();
    expect(container.textContent).toContain('notif-1');
    expect(notifCalls()).toHaveLength(2);
  });

  it('선출발도 제 요청도 실패 → 같은 실패 상자(영원히 로딩 아님 · 다시 돌지 않는다)', async () => {
    stubFetch(['network', 'network']);
    const { prefetchInbox, __resetInboxPrefetchForTest } = await import('@/components/inbox/inbox-prefetch');
    __resetInboxPrefetchForTest();
    prefetchInbox({ memberId: 'me-1', projectId: 'proj-1' }, 'notifications');
    await mount();
    await act(async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); });
    expect(skeletonCount()).toBe(0);
    expect(errorBox()?.textContent).toContain(koMessages.inbox.notificationsLoadError);
    expect(notifCalls()).toHaveLength(2);
  });
});

// story #4295(까디르 P2 ③) — «다시 시도»가 loading 반영 전에 두 번 눌려도 요청은 하나 · 늦게 온 실패가 성공을 덮지 않는다.
describe('«다시 시도» 연타 — 요청 하나(story #4295 까디르)', () => {
  it('⭐실패 상자에서 두 번 연달아 눌러도 알림 요청 1건 · 목록이 선다', async () => {
    stubFetch(['network', okPage([NOTIF('1')])]);
    await mount();
    const retry = buttonByText(koMessages.common.retry)!;
    const before = vi.mocked(fetch).mock.calls.filter(([u, init]) => String(u).includes('/api/notifications') && (init as RequestInit | undefined)?.method !== 'PATCH').length;
    await act(async () => {
      retry.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      retry.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await act(async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); });
    const after = vi.mocked(fetch).mock.calls.filter(([u, init]) => String(u).includes('/api/notifications') && (init as RequestInit | undefined)?.method !== 'PATCH').length;
    expect(after - before).toBe(1);
    expect(errorBox()).toBeNull();
    expect(container.textContent).toContain('notif-1');
  });

  it('⭐StrictMode 이중 마운트 effect(개발 모드)에서도 첫 쪽이 선다 — 연타 가드가 마운트 호출을 막지 않는다', async () => {
    stubFetch([okPage([NOTIF('1')])]);
    const { default: InboxPage } = await import('./page');
    await act(async () => {
      root.render(
        <StrictMode>
          <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
            <TopBarProvider><InboxPage /></TopBarProvider>
          </NextIntlClientProvider>
        </StrictMode>,
      );
    });
    await act(async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); });
    expect(skeletonCount()).toBe(0);
    expect(container.textContent).toContain('notif-1');
  });
});
