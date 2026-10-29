// @vitest-environment jsdom
//
// story #4004(E-UX-OVERHAUL·셸 통합 3/N·FE) — 공유 nav-item 목록의 렌더 회귀가드.
// 목적지 값 자체는 nav-v3-destinations.test.ts가 표로 이미 pin — 여기는 그 값이
// 실제로 href/라벨/활성 표시/배지로 이어지는지만 잰다.
import { afterEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { NavV3ItemList } from './nav-v3-item-list';
import { DEFAULT_NAV_V3_FLAGS, type NavV3Flags } from '@/lib/nav-v3-destinations';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

function wrap(node: React.ReactNode) {
  return <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">{node}</NextIntlClientProvider>;
}

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
});

async function mount(flags: NavV3Flags, activeKey: 'today' | 'chats' | 'work' | 'results' | 'connectRules', todayBadgeCount = 0) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(wrap(<NavV3ItemList flags={flags} activeKey={activeKey} todayBadgeCount={todayBadgeCount} />));
  });
}

describe('NavV3ItemList — story #4004 AC1(목적지 5항목·라벨)', () => {
  it('플래그 전부 OFF — connectRules 제외 4항목만 렌더, 라벨은 레거시 사이드바와 동일한 낱말', async () => {
    await mount(DEFAULT_NAV_V3_FLAGS, 'today');
    const links = [...container.querySelectorAll('a')];
    expect(links.map((a) => a.textContent?.replace(/\d+$/, '').trim())).toEqual(['오늘', '대화', '일감', '결과']);
    expect(links.map((a) => a.getAttribute('href'))).toEqual(['/org-briefing', '/chats', '/flow', '/organization/insights-board']);
  });

  it('connectRulesV3Enabled=true — 5번째 「연결·규칙」 항목이 맨 끝에 추가', async () => {
    await mount({ ...DEFAULT_NAV_V3_FLAGS, connectRulesV3Enabled: true }, 'today');
    const links = [...container.querySelectorAll('a')];
    expect(links).toHaveLength(5);
    expect(links[4]?.textContent).toBe('연결·규칙');
    expect(links[4]?.getAttribute('href')).toBe('/connect-rules');
  });

  it('플래그 전부 ON — 오늘·대화·일감 목적지가 v3 경로로', async () => {
    const flags: NavV3Flags = { todayV3Enabled: true, chatV3Enabled: true, connectRulesV3Enabled: true };
    await mount(flags, 'today');
    const links = [...container.querySelectorAll('a')];
    expect(links.map((a) => a.getAttribute('href'))).toEqual(['/today', '/chat', '/work-list', '/organization/insights-board', '/connect-rules']);
  });
});

describe('NavV3ItemList — story #4006 §6 역전 활성 표시(레거시 sidebar page-active 묶음, doc 5bc82986)', () => {
  it('활성 항목 — bg-sidebar-active-fill·border-l-proof-citron·font-medium·text-sidebar-active-fill-foreground·aria-current="page"', async () => {
    await mount(DEFAULT_NAV_V3_FLAGS, 'chats');
    const chatsLink = [...container.querySelectorAll('a')].find((a) => a.textContent === '대화')!;
    expect(chatsLink.className).toContain('bg-sidebar-active-fill');
    expect(chatsLink.className).toContain('border-l-proof-citron');
    expect(chatsLink.className).toContain('font-medium');
    expect(chatsLink.className).toContain('text-sidebar-active-fill-foreground');
    expect(chatsLink.getAttribute('aria-current')).toBe('page');
  });

  it('비활성 항목 — text-muted-foreground·hover:bg-muted(중립)·border-l-transparent(자리 예약)·activefill 미포함·aria-current 없음', async () => {
    await mount(DEFAULT_NAV_V3_FLAGS, 'chats');
    const todayLink = [...container.querySelectorAll('a')].find((a) => a.textContent === '오늘')!;
    expect(todayLink.className).toContain('text-muted-foreground');
    expect(todayLink.className).toContain('hover:bg-muted');
    expect(todayLink.className).toContain('border-l-transparent');
    expect(todayLink.className).not.toContain('bg-sidebar-active-fill');
    expect(todayLink.className).not.toContain('border-l-proof-citron');
    expect(todayLink.getAttribute('aria-current')).toBeNull();
  });

  it('활성·비활성 전 항목에 포커스 링(신규, 현행 v3엔 없었음)', async () => {
    await mount(DEFAULT_NAV_V3_FLAGS, 'today');
    const links = [...container.querySelectorAll('a')];
    for (const link of links) {
      expect(link.className).toContain('focus-visible:ring-2');
      expect(link.className).toContain('focus-visible:ring-ring');
      expect(link.className).toContain('focus-visible:ring-offset-2');
    }
  });

  it('activeKey마다 정확히 그 항목 하나만 활성(교차 오염 0)', async () => {
    for (const key of ['today', 'chats', 'work', 'results'] as const) {
      await mount(DEFAULT_NAV_V3_FLAGS, key);
      const activeLinks = [...container.querySelectorAll('a[aria-current="page"]')];
      expect(activeLinks).toHaveLength(1);
      await act(async () => { root.unmount(); });
      container.remove();
    }
  });
});

describe('NavV3ItemList — 「오늘」 배지(story #4004, today-v3-screen.tsx 기존 동작 이관)', () => {
  it('todayBadgeCount=0이면 배지 없음', async () => {
    await mount(DEFAULT_NAV_V3_FLAGS, 'today', 0);
    const todayLink = [...container.querySelectorAll('a')].find((a) => a.textContent?.startsWith('오늘'))!;
    expect(todayLink.querySelector('span.bg-primary')).toBeNull();
  });

  it('todayBadgeCount=3이면 「오늘」 항목에만 배지, 다른 항목엔 없음', async () => {
    await mount(DEFAULT_NAV_V3_FLAGS, 'today', 3);
    const todayLink = [...container.querySelectorAll('a')].find((a) => a.textContent?.startsWith('오늘'))!;
    expect(todayLink.querySelector('span.bg-primary')?.textContent).toBe('3');
    const chatsLink = [...container.querySelectorAll('a')].find((a) => a.textContent === '대화')!;
    expect(chatsLink.querySelector('span.bg-primary')).toBeNull();
  });
});
