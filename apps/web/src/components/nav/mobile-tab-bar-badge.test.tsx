// @vitest-environment jsdom
//
// story #3431(공용, PO 確定 2026-09-05) — 그라운딩 중 발견한 3번째 복사본(chat/approvals
// 카운트 배지, `CircleDot`/`Inbox` 옆이 아니라 오른쪽 옆에 얹는 위치)을 공용
// CornerCountBadge로 통합했다 — 색·크기·값 상한(9+/99+) 로직은 무변경, 위치와 정의만 접었다.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';

vi.mock('next/navigation', () => ({
  usePathname: () => '/flow',
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

function wrap(node: React.ReactNode) {
  return (
    <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
      {node}
    </NextIntlClientProvider>
  );
}

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.unstubAllGlobals();
});

async function mount(pendingCount: number, chatUnreadTotal: number) {
  // MobileTabBar의 pendingCount effect는 window.innerWidth < MOBILE_BREAKPOINT(1024)일
  // 때만 fetch한다(유나 지적 #2249 — 데스크톱에서 불필요한 왕복 금지). jsdom 기본값(1024)은
  // 그 조건을 안 타므로 모바일 폭으로 명시 고정한다(390 — 이 레포 라이브픽셀 관례 폭).
  Object.defineProperty(window, 'innerWidth', { writable: true, configurable: true, value: 390 });
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.includes('/api/gates/designated-pending-count')) {
      return new Response(JSON.stringify({ count: pendingCount }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(JSON.stringify([]), { status: 200, headers: { 'content-type': 'application/json' } });
  }));
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  const { MobileTabBar } = await import('./mobile-tab-bar');
  await act(async () => { root.render(wrap(<MobileTabBar chatUnreadTotal={chatUnreadTotal} />)); });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}

describe('MobileTabBar — 결재/채팅 카운트 배지(story #3431 CornerCountBadge 통합)', () => {
  it('두 배지 모두 0건이면 배지 자체가 안 뜬다', async () => {
    await mount(0, 0);
    expect(container.querySelector('span[aria-hidden]')).toBeNull();
  });

  it('결재 대기 5건 — primary variant·10px·9+ 상한 유지', async () => {
    await mount(5, 0);
    const badge = container.querySelector('span[aria-hidden]');
    expect(badge?.textContent).toBe('5');
    expect(badge?.className).toContain('bg-primary');
    expect(badge?.className).toContain('text-primary-foreground');
    expect(badge?.className).toContain('text-[10px]');
    expect(badge?.className).toContain('absolute');
    expect(badge?.className).toContain('left-full');
  });

  it('결재 대기 12건 — 9+ 상한(기존 로직 무변경)', async () => {
    await mount(12, 0);
    const badge = container.querySelector('span[aria-hidden]');
    expect(badge?.textContent).toBe('9+');
  });

  it('채팅 unread 150건 — 99+ 상한(기존 로직 무변경, 결재와 다른 캡)', async () => {
    await mount(0, 150);
    const badge = container.querySelector('span[aria-hidden]');
    expect(badge?.textContent).toBe('99+');
  });
});
