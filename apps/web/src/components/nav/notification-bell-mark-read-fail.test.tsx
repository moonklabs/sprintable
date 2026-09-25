// @vitest-environment jsdom
//
// story #3637(유나 silent-failure-sweep-3632, doc 자리 ②) — handleMarkRead/
// handleMarkAllRead가 서버 실패 시 조용히 롤백되던 자리(안읽음으로 되돌아감/배지가
// 다시 차오름, 문구 0). addToast로 문장을 낸다(새 규격 0 — toast.tsx 기존 컴포넌트 재사용).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { ToastProvider, ToastContainer, useToast } from '@/components/ui/toast';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
}));

const { NotificationBell } = await import('./notification-bell');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// story #3759 — NotificationBell이 useToast()로 공유 Context를 구독한다.
function TestToastRenderer() {
  const { toasts, dismissToast } = useToast();
  return <ToastContainer toasts={toasts} onDismiss={dismissToast} />;
}

function withIntl(node: React.ReactNode) {
  return (
    <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
      <ToastProvider>
        {node}
        <TestToastRenderer />
      </ToastProvider>
    </NextIntlClientProvider>
  );
}

function stubMatchMedia() {
  vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({
    matches: true,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
}

function unreadNotif(id: string) {
  return {
    id, event_type: 'story_status_changed', source_entity_type: null, source_entity_id: null,
    payload: { summary: `알림 ${id}` }, read_at: null, created_at: '2026-07-27T00:00:00Z',
  };
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  stubMatchMedia();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function stubFetch(patchOk: boolean, patchNetworkError = false) {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    // story #4295 — 망 오류(fetch가 던짐)도 서버 실패와 같게 다뤄야 한다.
    if (patchNetworkError && init?.method === 'PATCH') throw new TypeError('Failed to fetch');
    if (url.includes('/api/event-notifications?')) {
      return new Response(JSON.stringify({ data: [unreadNotif('n1')], meta: { hasMore: false } }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    }
    if (url.includes('/read-all')) {
      return new Response('{}', { status: patchOk ? 200 : 500 });
    }
    if (url.includes('/read') && init?.method === 'PATCH') {
      return new Response('{}', { status: patchOk ? 200 : 500 });
    }
    return new Response(JSON.stringify({ count: 1 }), { status: 200, headers: { 'content-type': 'application/json' } });
  }));
}

async function openBell() {
  await act(async () => { root.render(withIntl(<NotificationBell />)); });
  const bellButton = container.querySelector('button[aria-expanded]') as HTMLButtonElement;
  await act(async () => { bellButton.click(); });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}

describe('NotificationBell — 낙관 읽음 처리 실패 시 문장(story #3637)', () => {
  it('개별 읽음(handleMarkRead) 실패 시 markReadFailed 토스트가 뜬다', async () => {
    stubFetch(false);
    await openBell();
    const itemBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes('알림 n1'));
    await act(async () => { itemBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(container.textContent).toContain(koMessages.inbox.markReadFailed);
  });

  it('전체 읽음(handleMarkAllRead) 실패 시 markAllReadFailed 토스트가 뜬다', async () => {
    stubFetch(false);
    await openBell();
    const allReadBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes(koMessages.inbox.markAllRead));
    await act(async () => { allReadBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(container.textContent).toContain(koMessages.inbox.markAllReadFailed);
  });

  // 뮤테이션 대표 — 성공 시엔 토스트가 안 뜬다(과보고 방지).
  it('개별 읽음 성공 시엔 토스트가 안 뜬다', async () => {
    stubFetch(true);
    await openBell();
    const itemBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes('알림 n1'));
    await act(async () => { itemBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(container.textContent).not.toContain(koMessages.inbox.markReadFailed);
  });

  // story #4295 — 망 오류(fetch가 던짐)는 예전엔 처리 안 된 거부로 새고 낙관적 «읽음»이 남았다.
  async function expectNoUnhandled(run: () => Promise<void>) {
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    await run();
    await new Promise((r) => setTimeout(r, 0));
    process.off('unhandledRejection', unhandled);
    expect(unhandled).not.toHaveBeenCalled();
  }

  it('⭐개별 읽음이 망 오류여도 markReadFailed 토스트(처리 안 된 거부 없음)', async () => {
    await expectNoUnhandled(async () => {
      stubFetch(true, true);
      await openBell();
      const itemBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes('알림 n1'));
      await act(async () => { itemBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
      await act(async () => { await Promise.resolve(); await Promise.resolve(); });
      expect(container.textContent).toContain(koMessages.inbox.markReadFailed);
    });
  });

  it('⭐전체 읽음이 망 오류여도 markAllReadFailed 토스트(처리 안 된 거부 없음)', async () => {
    await expectNoUnhandled(async () => {
      stubFetch(true, true);
      await openBell();
      const allReadBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes(koMessages.inbox.markAllRead));
      await act(async () => { allReadBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
      await act(async () => { await Promise.resolve(); await Promise.resolve(); });
      expect(container.textContent).toContain(koMessages.inbox.markAllReadFailed);
    });
  });
});

// story #4295(까디르 P2 ①②) — «모두 읽음» 실패면 열린 목록도 바꾸기 전으로(배지만 다시 차고 목록은 전부 읽음 · 버튼 사라짐 = 한 화면 두 세계),
// 보정용 안 읽음 수 재조회까지 망 오류여도 처리 안 된 거부가 새지 않는다.
describe('NotificationBell — «모두 읽음» 실패 뒤 목록 · 배지가 같은 세계(story #4295)', () => {
  const allReadButton = () => Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes(koMessages.inbox.markAllRead));

  it('⭐서버 실패 → 목록이 안 읽음으로 되돌아와 «모두 읽음» 버튼이 다시 보인다', async () => {
    stubFetch(false);
    await openBell();
    expect(allReadButton(), '누르기 전').toBeTruthy();
    await act(async () => { allReadButton()!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await act(async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); });
    expect(container.textContent).toContain(koMessages.inbox.markAllReadFailed);
    expect(allReadButton(), '실패 뒤 — 목록이 되돌아와 버튼이 남는다').toBeTruthy();
  });

  it('⭐읽음 요청 · 보정 재조회가 둘 다 망 오류여도 처리 안 된 거부 0', async () => {
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
        if (url.includes('/api/event-notifications?')) {
          return new Response(JSON.stringify({ data: [unreadNotif('n1')], meta: { hasMore: false } }), {
            status: 200, headers: { 'content-type': 'application/json' },
          });
        }
        if (init?.method === 'PATCH' || url.includes('/unread-count')) throw new TypeError('Failed to fetch');
        return new Response('{}', { status: 200 });
      }));
      await openBell();
      await act(async () => { allReadButton()!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
      await act(async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); });
      await new Promise((r) => setTimeout(r, 0));
      expect(container.textContent).toContain(koMessages.inbox.markAllReadFailed);
    } finally {
      process.off('unhandledRejection', unhandled);
    }
    expect(unhandled).not.toHaveBeenCalled();
  });
});
