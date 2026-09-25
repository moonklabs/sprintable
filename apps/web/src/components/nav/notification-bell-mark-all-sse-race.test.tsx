// @vitest-environment jsdom
// story #4295(까디르 P2 · PO 정정) — «모두 읽음»이 망 오류 → 개수만 다시 받음(0) · 목록 재조회 실패 갈래에서, 예전엔 지금 안 읽은 행을
// **전부** 읽음으로 바꿔 복구 도중 SSE로 온 새 알림까지 숨겼다(서버엔 안 읽음인데 화면만 읽음). 이번 시도가 바꾼 행만 다시 읽음이어야 한다.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { ToastProvider } from '@/components/ui/toast';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }) }));
const sse = vi.hoisted(() => ({ onNotification: null as null | ((n: unknown) => void) }));
vi.mock('@/hooks/use-sse-notifications', () => ({
  useSseNotifications: (opts: { onNotification: (n: unknown) => void }) => { sse.onNotification = opts.onNotification; },
}));

const { NotificationBell } = await import('./notification-bell');
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
const unread = (id: string) => ({ id, event_type: 'story_status_changed', source_entity_type: null, source_entity_id: null, payload: { summary: `알림 ${id}` }, read_at: null, created_at: '2026-07-27T00:00:00Z' });

beforeEach(() => {
  vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.unstubAllGlobals();
});

describe('NotificationBell — «모두 읽음» 복구 중 SSE로 온 새 알림(story #4295)', () => {
  it('⭐개수 0 · 목록 재조회 실패 → 이번에 바꾼 행만 다시 읽음 · 복구 도중 온 새 알림은 안 읽음 그대로(«모두 읽음» 버튼 남음)', async () => {
    let rejectPatch: (e: unknown) => void = () => {};
    let patched = false;
    vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => {
      if (init?.method === 'PATCH') {
        patched = true;
        return new Promise((_resolve, reject) => { rejectPatch = reject; });
      }
      if (url.includes('/api/event-notifications?')) {
        return patched ? Promise.reject(new TypeError('Failed to fetch')) : Promise.resolve(json({ data: [unread('n1')], meta: { hasMore: false } }));
      }
      if (url.includes('/unread-count')) return Promise.resolve(json({ count: patched ? 0 : 1 }));
      return Promise.resolve(new Response('{}', { status: 200 }));
    }));
    await act(async () => {
      root.render(<NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul"><ToastProvider><NotificationBell /></ToastProvider></NextIntlClientProvider>);
    });
    await act(async () => { (container.querySelector('button[aria-expanded]') as HTMLButtonElement).click(); });
    await act(async () => { for (let i = 0; i < 4; i++) await Promise.resolve(); });
    const allRead = () => [...container.querySelectorAll('button')].find((b) => b.textContent?.includes(koMessages.inbox.markAllRead));
    expect(allRead(), '누르기 전').toBeTruthy();

    await act(async () => { allRead()!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    // «모두 읽음» 요청이 걸려 있는 동안 SSE로 새 알림이 온다.
    await act(async () => { sse.onNotification!({ ...unread('n2'), payload: { summary: '알림 n2' } }); });
    await act(async () => { rejectPatch(new TypeError('Failed to fetch')); for (let i = 0; i < 10; i++) await Promise.resolve(); });
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });

    expect(container.textContent).toContain('알림 n2');
    expect(allRead(), '새 알림은 안 읽음 — 모두 읽음 버튼이 남는다').toBeTruthy();
    expect(container.textContent).not.toContain(koMessages.inbox.markAllReadFailed);
  });
});
