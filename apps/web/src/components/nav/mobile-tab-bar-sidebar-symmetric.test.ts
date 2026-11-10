// story #4016 AC3 → story #4885 — 모바일 탭 바(플래그 OFF = 지금 서 있는 탭)의 각 탭 목적지 == 같은 키의 사이드바 목적지. 새 셸의 사이드바는 플래그 없이 하나라(정본 = 지금 서 있는
// 화면) v3 플래그를 켠 8조합 대칭은 더는 약속이 아니다 — v3 탭(V3_TABS)은 꺼진 시안이라 켜지도 떼지도 않는다. 지금 서 있는 쪽(OFF)만 구조로 고정한다:
// now↔work·chat↔chats·approvals↔inbox가 탭 바(resolveTabHref)와 사이드바 데이터(nav-config.ts)에서 같은 곳을 가리키는지(한쪽만 갱신되는 drift 재발 방지, PO 지적 2026-09-17 14:26Z).
// approvals는 story #4885에서 사이드바에도 «결재»(같은 이름 · 같은 착지 /inbox?tab=gates)로 돌아와 대칭 대상이 셋이 됐다. more는 사이드바 맨 아래 «전체»와 같은 /more.
import { describe, expect, it } from 'vitest';
import { ALL_SCREENS_ITEM, CHAT_CENTER_ITEM, NAV_GROUPS } from '@/lib/nav-config';
import { DEFAULT_NAV_V3_FLAGS, resolveNavV3Destinations } from '@/lib/nav-v3-destinations';
import { TABS, resolveTabHref } from './mobile-tab-bar';

const dest = resolveNavV3Destinations(DEFAULT_NAV_V3_FLAGS);
const sidebarItem = (id: string) => {
  const item = NAV_GROUPS.flatMap((g) => g.items).find((i) => i.id === id);
  if (!item) throw new Error(`사이드바 NAV_GROUPS에서 ${id} 항목을 찾지 못함(nav-config.ts 구조 변경?)`);
  return item;
};

describe('mobile-tab-bar ↔ app-sidebar 대칭(플래그 OFF = 지금)', () => {
  it('now 탭(work) — 사이드바 board 항목과 같은 리소스 조각', () => {
    const nowTab = TABS.find((t) => t.key === 'now')!;
    expect(resolveTabHref(nowTab, dest, {}, (h) => h).replace(/^\//, '')).toBe(sidebarItem('board').path);
  });

  it('chat 탭 — 사이드바 CHAT_CENTER_ITEM과 같은 경로', () => {
    const chatTab = TABS.find((t) => t.key === 'chat')!;
    expect(resolveTabHref(chatTab, dest, {}, (h) => h)).toBe(CHAT_CENTER_ITEM.path);
  });

  it('approvals 탭 — 사이드바 «결재»(inbox)와 같은 착지(게이트 탭) · 같은 이름(labelKey)', () => {
    const tab = TABS.find((t) => t.key === 'approvals')!;
    expect(resolveTabHref(tab, dest, {}, (h) => h)).toBe(sidebarItem('inbox').path);
    expect(tab.labelKey).toBe(sidebarItem('inbox').labelKey);
  });

  it('more 탭 — 사이드바 맨 아래 «전체»와 같은 /more', () => {
    const tab = TABS.find((t) => t.key === 'more')!;
    expect(resolveTabHref(tab, dest, {}, (h) => h)).toBe(ALL_SCREENS_ITEM.path);
  });
});
