// @vitest-environment jsdom
//
// story #4349(전수 15번 · PO 11:39Z «부류를 닫는다») — 넓은 화면 알림 드롭다운은 셸 스크롤 면(`dashboard-shell` `overflow-y-auto`) 안의
// absolute였다(창보다 길면 잘림) → body로 포털(AnchoredPopover · 벨 오른쪽 끝 · 아래 4px). 포털이라 DOM 순서상 벨 뒤가 아니다 →
// 벨에서 Tab이면 패널 첫 조작으로 · 끝을 넘거나 Esc면 닫고 벨로(패널형 공용 훅). 좁은 화면 풀스크린 오버레이는 그대로(fixed · 자기 트랩).
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
  vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  vi.stubGlobal('EventSource', class { addEventListener() {} close() {} });
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.includes('/api/event-notifications?')) {
      const item = { id: 'n1', event_type: 'story_status_changed', source_entity_type: null, source_entity_id: null, payload: { summary: '알림 n1' }, read_at: null, created_at: '2026-09-26T00:00:00Z' };
      return new Response(JSON.stringify({ data: [item], meta: { hasMore: false } }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify({ count: 1 }), { status: 200, headers: { 'content-type': 'application/json' } });
  }));
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const isPanel = this.getAttribute('data-dropdown-panel') === 'notification-bell';
    const isWrap = !isPanel && this.classList.contains('relative') && this.querySelector(':scope > button[aria-expanded]') !== null;
    const r = isPanel ? { left: 900, right: 1220, top: 0, bottom: 400, width: 320, height: 400 }
      : isWrap ? { left: 1188, right: 1220, top: 12, bottom: 44, width: 32, height: 32 }
        : { left: 0, right: 0, top: 0, bottom: 0, width: 0, height: 0 };
    return { ...r, x: r.left, y: r.top, toJSON: () => r } as DOMRect;
  });
  container = document.createElement('div');
  container.className = 'overflow-y-auto'; // 셸 스크롤 면 흉내
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

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
const panel = () => document.querySelector<HTMLElement>('[data-dropdown-panel="notification-bell"]');
const key = (el: Element, k: string, shiftKey = false) => act(async () => { el.dispatchEvent(new KeyboardEvent('keydown', { key: k, shiftKey, bubbles: true })); });

describe('NotificationBell 넓은 화면 드롭다운 — 셸 스크롤 면 밖(body) · 키보드(story #4349 전수 15번)', () => {
  it('열면 넓은 화면 패널은 body 직속 fixed · 스크롤 면 밖 · 벨 오른쪽 끝에 맞춰 아래 4px · 좁은 화면 오버레이는 그대로 container 안', async () => {
    await openBell();
    expect(panel()!.parentElement).toBe(document.body);
    expect(container.contains(panel())).toBe(false);
    expect(panel()!.style.position).toBe('fixed');
    expect(panel()!.style.top).toBe('48px');
    expect(panel()!.style.left).toBe('900px'); // 1220 − 320
    expect(container.querySelector('[role="dialog"]')).not.toBeNull();
  });

  it('벨에서 Tab → 패널 첫 조작 · Esc → 닫고 벨(셸 트랩 document keydown 0)', async () => {
    const bell = await openBell();
    await key(bell, 'Tab');
    expect(panel()!.contains(document.activeElement)).toBe(true);
    const trap = vi.fn();
    document.addEventListener('keydown', trap);
    await key(document.activeElement!, 'Escape');
    document.removeEventListener('keydown', trap);
    expect(panel()).toBeNull();
    expect(document.activeElement).toBe(bell);
    expect(trap.mock.calls.filter(([e]) => (e as KeyboardEvent).key === 'Escape')).toHaveLength(0);
  });

  it('포털된 패널 안을 누르면 안 닫힘 · 바깥이면 닫힘', async () => {
    await openBell();
    await act(async () => { panel()!.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })); });
    expect(panel()).not.toBeNull();
    await act(async () => { document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })); });
    expect(panel()).toBeNull();
  });
});
