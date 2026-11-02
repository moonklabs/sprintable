// @vitest-environment jsdom
//
// story 4831 덮개 — 알림 종의 좁은 화면(lg 미만) 풀스크린 오버레이는 바탕 Dialog/Popover로 옮기지 않고 «까닭 + 현재 동작을 잠그는 시험»과 함께 덮개 명단에 남는다.
// 까닭: 같은 NotificationPanel을 넓은 화면의 포털 패널(공용 패널 열쇠 훅의 Tab/Esc · 벨 반환)과 좁은 화면의 풀스크린 오버레이로 나눠 그리고, 오버레이는 공용 useFocusTrap(자기 트랩)이
// 초점 · Tab 순환 · Esc · 여는 자리로 반환을 맡는다. 바탕 Dialog로 감싸면 두 층(base-ui 트랩 + 이 훅)이 겹치고 공용 패널 열쇠 훅과 초점/Esc가 부딪친다.
// 이 파일이 그 현재 동작을 잠근다(옮기려면 이 시험이 먼저 빨개져야 한다).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }) }));
const { NotificationBell } = await import('./notification-bell');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  // 좁은 화면: (min-width: 1024px)가 거짓
  vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  vi.stubGlobal('EventSource', class { addEventListener() {} close() {} });
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.includes('/api/event-notifications?')) {
      const item = { id: 'n1', event_type: 'story_status_changed', source_entity_type: null, source_entity_id: null, payload: { summary: '알림 n1' }, read_at: null, created_at: '2026-09-26T00:00:00Z' };
      return new Response(JSON.stringify({ data: [item], meta: { hasMore: false } }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify({ count: 1 }), { status: 200, headers: { 'content-type': 'application/json' } });
  }));
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

const FOCUSABLE = 'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';
const hasClass = (el: Element, token: string) => el.className.split(/\s+/).includes(token);
const overlay = () => container.querySelector<HTMLElement>('[role="dialog"]');

async function openBell() {
  await act(async () => {
    root.render(<NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul"><NotificationBell /></NextIntlClientProvider>);
  });
  const bell = container.querySelector<HTMLButtonElement>('button[aria-expanded]')!;
  bell.focus();
  await act(async () => { bell.click(); });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  return bell;
}
async function key(el: Element, k: string, shiftKey = false) {
  const ev = new KeyboardEvent('keydown', { key: k, shiftKey, bubbles: true, cancelable: true });
  await act(async () => { el.dispatchEvent(ev); });
  return ev;
}

describe('NotificationBell 좁은 화면 풀스크린 오버레이 — 덮개 명단 잠금(현재 동작)', () => {
  it('풀스크린(fixed inset-0) 모달 role=dialog이고 접근 이름이 «알림»이며 container 안에 그려진다(포털 아님)', async () => {
    await openBell();
    const o = overlay()!;
    expect(o).not.toBeNull();
    expect(o.getAttribute('aria-modal')).toBe('true');
    expect(o.getAttribute('aria-label')).toBe(koMessages.inbox.panelTitle);
    for (const t of ['fixed', 'inset-0', 'flex-col']) expect(hasClass(o, t), t).toBe(true);
    expect(container.contains(o)).toBe(true);
    // jsdom은 Tailwind 반응형 클래스를 평가하지 않아 넓은 화면 패널도 DOM에 같이 있다 — 하나만 보이게 하는 것은 CSS 클래스다: 오버레이 lg:hidden · 넓은 화면 패널 hidden(lg:flex)
    expect(hasClass(o, 'lg:hidden')).toBe(true);
    const desktopPanel = document.querySelector<HTMLElement>('[data-dropdown-panel="notification-bell"]')!;
    expect(hasClass(desktopPanel, 'hidden') && hasClass(desktopPanel, 'lg:flex')).toBe(true);
  });

  it('열면 초점이 오버레이 안으로 들어간다(자기 트랩)', async () => {
    await openBell();
    expect(overlay()!.contains(document.activeElement)).toBe(true);
  });

  it('Tab은 오버레이 안에서 돈다 — 마지막 조작에서 Tab은 첫 조작으로 · 첫 조작에서 Shift+Tab은 마지막으로', async () => {
    await openBell();
    const items = [...overlay()!.querySelectorAll<HTMLElement>(FOCUSABLE)];
    expect(items.length).toBeGreaterThan(1);
    items[items.length - 1]!.focus();
    const forward = await key(items[items.length - 1]!, 'Tab');
    expect(forward.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(items[0]);
    const backward = await key(items[0]!, 'Tab', true);
    expect(backward.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(items[items.length - 1]);
  });

  it('Esc는 오버레이를 닫고 초점을 연 자리(벨)로 돌려준다', async () => {
    const bell = await openBell();
    await key(document.activeElement!, 'Escape');
    expect(overlay()).toBeNull();
    expect(document.activeElement).toBe(bell);
    expect(bell.getAttribute('aria-expanded')).toBe('false');
  });
});
