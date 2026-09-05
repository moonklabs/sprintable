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
import enMessages from '../../../messages/en.json';

vi.mock('next/navigation', () => ({
  usePathname: () => '/flow',
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

function wrap(node: React.ReactNode, locale: 'ko' | 'en' = 'ko') {
  const messages = locale === 'ko' ? koMessages : enMessages;
  return (
    <NextIntlClientProvider locale={locale} messages={messages} timeZone="Asia/Seoul">
      {node}
    </NextIntlClientProvider>
  );
}

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.unstubAllGlobals();
});

async function mount(pendingCount: number, chatUnreadTotal: number, locale: 'ko' | 'en' = 'ko') {
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
  await act(async () => { root.render(wrap(<MobileTabBar chatUnreadTotal={chatUnreadTotal} />, locale)); });
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

// story #3518(유나 사전 스티어, 2026-09-05) — 배지는 aria-hidden이라 그 수를 보조
// 기술에 전하는 책임은 탭 링크에 있다. aria-label(접근성 이름 통째 교체)은 안 쓴다 —
// 이 탭은 보이는 텍스트 라벨("채팅"·"결재")이 있어서 aria-label로 갈아치우면 WCAG
// 2.5.3(Label in Name) 위반이다. 대신 보이는 라벨 뒤에 sr-only 텍스트를 "덧붙인다" —
// 접근성 이름은 여전히 라벨+children 텍스트 전체(배지의 aria-hidden 텍스트는 accname
// 계산에서 제외)로 계산된다. jsdom엔 실 accname 알고리즘이 없어 아래 헬퍼로 근사한다
// (aria-hidden 하위 텍스트를 제외한 텍스트 concat — 이 파일의 마크업 깊이에선 충분).
function collectVisibleText(el: Element): string {
  let out = '';
  for (const node of Array.from(el.childNodes)) {
    if (node.nodeType === Node.TEXT_NODE) {
      out += node.textContent ?? '';
    } else if (node.nodeType === Node.ELEMENT_NODE) {
      const child = node as Element;
      if (child.getAttribute('aria-hidden') === 'true') continue;
      out += collectVisibleText(child);
    }
  }
  return out;
}

// 재귀 도중엔(하위 호출마다) 다듬지 않는다 — 각 레벨에서 trim하면 "채팅"+" 읽지…"의
// 경계 공백이 하위 호출 안에서 먼저 잘려 "채팅읽지…"처럼 붙어버린다(실제 겪은 버그).
// 정규화는 최종 문자열에서 한 번만.
function approxAccessibleName(el: Element): string {
  return collectVisibleText(el).replace(/\s+/g, ' ').trim();
}

describe('MobileTabBar — 탭 접근성 이름에 카운트 포함(story #3518)', () => {
  it('배지 0건 — sr-only 텍스트가 안 붙는다(접근성 이름=보이는 라벨 그대로)', async () => {
    await mount(0, 0);
    const chatLink = [...container.querySelectorAll('a')].find((a) => a.getAttribute('href') === '/chats')!;
    expect(approxAccessibleName(chatLink)).toBe('채팅');
    expect(chatLink.getAttribute('aria-label')).toBeNull(); // 접근성 이름을 통째로 안 갈아치운다(WCAG 2.5.3).
  });

  it('결재 대기 5건 — 접근성 이름이 «보이는 라벨+수»(라벨을 안 지운다)', async () => {
    await mount(5, 0);
    const approvalsLink = [...container.querySelectorAll('a')].find((a) => a.getAttribute('href') === '/inbox?tab=gates')!;
    expect(approxAccessibleName(approvalsLink)).toBe('결재 대기 5건');
  });

  it('채팅 unread 3건 — 접근성 이름이 «보이는 라벨+수»', async () => {
    await mount(0, 3);
    const chatLink = [...container.querySelectorAll('a')].find((a) => a.getAttribute('href') === '/chats')!;
    expect(approxAccessibleName(chatLink)).toBe('채팅 읽지 않음 3건');
  });

  it('결재 대기 12건(시각 9+ 표기) — 접근성 이름엔 "9건 이상"(캡을 말로 반영, 시각 캡과 같은 뜻)', async () => {
    await mount(12, 0);
    const approvalsLink = [...container.querySelectorAll('a')].find((a) => a.getAttribute('href') === '/inbox?tab=gates')!;
    expect(approxAccessibleName(approvalsLink)).toBe('결재 대기 9건 이상');
    const badge = container.querySelector('span[aria-hidden]');
    expect(badge?.textContent).toBe('9+'); // 시각 배지는 그대로 '9+'.
  });

  it('채팅 unread 150건(시각 99+ 표기) — 접근성 이름엔 "99건 이상"', async () => {
    await mount(0, 150);
    const chatLink = [...container.querySelectorAll('a')].find((a) => a.getAttribute('href') === '/chats')!;
    expect(approxAccessibleName(chatLink)).toBe('채팅 읽지 않음 99건 이상');
    const badge = container.querySelector('span[aria-hidden]');
    expect(badge?.textContent).toBe('99+');
  });

  // story #3518(유나 사전 스티어 H, PO 決定) — 결재 sr 문구는 EN에서 "pending approval"
  // 이라는 셀 수 있는 명사라 ICU plural이 실제로 갈린다(1 vs 그 외). 채팅 "unread"는
  // 형용사성이라 단수·복수 형태 차이가 없다(그래도 count=1 경계값은 확인).
  it('[en] 결재 대기 1건 — ICU plural one 갈래("1 pending approval", 단수)', async () => {
    await mount(1, 0, 'en');
    const approvalsLink = [...container.querySelectorAll('a')].find((a) => a.getAttribute('href') === '/inbox?tab=gates')!;
    expect(approxAccessibleName(approvalsLink)).toBe('Approvals 1 pending approval');
  });

  it('[en] 결재 대기 5건 — ICU plural other 갈래("5 pending approvals", 복수)', async () => {
    await mount(5, 0, 'en');
    const approvalsLink = [...container.querySelectorAll('a')].find((a) => a.getAttribute('href') === '/inbox?tab=gates')!;
    expect(approxAccessibleName(approvalsLink)).toBe('Approvals 5 pending approvals');
  });

  it('[en] 채팅 unread 1건 — "1 unread"(형태 안 갈림, count=1 경계값 확인)', async () => {
    await mount(0, 1, 'en');
    const chatLink = [...container.querySelectorAll('a')].find((a) => a.getAttribute('href') === '/chats')!;
    expect(approxAccessibleName(chatLink)).toBe('Chat 1 unread');
  });
});
