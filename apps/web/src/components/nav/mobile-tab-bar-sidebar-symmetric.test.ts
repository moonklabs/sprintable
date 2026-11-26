// story #4016 AC3 → story #4885 — 모바일 탭 바(플래그 OFF = 지금 서 있는 탭)의 각 탭 목적지 == 같은 키의 사이드바 목적지. 새 셸의 사이드바는 플래그 없이 하나라(정본 = 지금 서 있는
// 화면) v3 플래그를 켠 8조합 대칭은 더는 약속이 아니다 — v3 탭(V3_TABS)은 꺼진 시안이라 켜지도 떼지도 않는다. 지금 서 있는 쪽(OFF)만 구조로 고정한다:
// 홈↔org-briefing·일감↔board·대화↔chats가 탭 바(resolveTabHref)와 사이드바 데이터(nav-config.ts)에서 같은 곳을 가리키는지(한쪽만 갱신되는 drift 재발 방지, PO 지적 2026-09-17 14:26Z).
// story 5031 (C1 4단계) — 폰 탭이 웹 아이콘 막대와 같은 넷(홈 · 채팅 · 에이전트 · 설정)으로 바뀌었다: 대칭 대상은 홈↔org-briefing · 채팅↔chats(CHAT_CENTER_ITEM) · 에이전트↔org-workforce · 설정↔settings.
// 일감(board)과 «전체»(/more)는 탭이 아니다 — 일감은 채팅 자리의 목록 줄, /more는 ⌘K 「모든 화면」(상단 막대 검색)이다. 채팅 탭 이름은 nav.depth1Chat(웹 막대와 한 낱말)이라 사이드바 chats(대화)와 일부러 다르다.
import { describe, expect, it } from 'vitest';
import { ALL_SCREENS_ITEM, CHAT_CENTER_ITEM, NAV_GROUPS } from '@/lib/nav-config';
import { DEFAULT_NAV_V3_FLAGS, resolveNavV3Destinations } from '@/lib/nav-v3-destinations';
import { PHONE_TABS, resolveTabHref } from './mobile-tab-bar';

const dest = resolveNavV3Destinations(DEFAULT_NAV_V3_FLAGS);
const sidebarItem = (id: string) => {
  const item = NAV_GROUPS.flatMap((g) => g.items).find((i) => i.id === id);
  if (!item) throw new Error(`사이드바 NAV_GROUPS에서 ${id} 항목을 찾지 못함(nav-config.ts 구조 변경?)`);
  return item;
};

describe('mobile-tab-bar ↔ app-sidebar 대칭(플래그 OFF = 지금)', () => {
  const tabOf = (key: string) => PHONE_TABS.find((t) => t.key === key)!;
  const same = (h: string) => h;

  it('홈 탭 — 사이드바 «홈»(org-briefing)과 같은 경로 · 같은 이름(labelKey)', () => {
    const tab = tabOf('today');
    expect(resolveTabHref(tab, dest, {}, same)).toBe(sidebarItem('org-briefing').path);
    expect(tab.labelKey).toBe(sidebarItem('org-briefing').labelKey);
  });

  it('chat 탭 — 사이드바 CHAT_CENTER_ITEM과 같은 경로, 이름은 nav.depth1Chat(웹 막대 「채팅」)이라 사이드바 chats(「대화」)와 다르다', () => {
    const tab = tabOf('chat');
    expect(resolveTabHref(tab, dest, {}, same)).toBe(CHAT_CENTER_ITEM.path);
    expect(tab.labelKey).toBe('depth1Chat');
    expect(tab.labelKey).not.toBe(CHAT_CENTER_ITEM.labelKey);
  });

  it('agents 탭 — 사이드바 org-workforce 항목과 같은 경로 · 같은 이름(workforce)', () => {
    const tab = tabOf('agents');
    expect(resolveTabHref(tab, dest, {}, same)).toBe(sidebarItem('org-workforce').path);
    expect(tab.labelKey).toBe(sidebarItem('org-workforce').labelKey);
  });

  it('settings 탭 — 사이드바 settings 항목과 같은 경로 · 같은 이름(settings)', () => {
    const tab = tabOf('settings');
    expect(resolveTabHref(tab, dest, {}, same)).toBe(sidebarItem('settings').path);
    expect(tab.labelKey).toBe(sidebarItem('settings').labelKey);
  });

  it('⭐일감(work)과 «전체»(more)는 폰 탭이 아니다 — 사이드바에는 board 항목 · 맨 아래 «전체»(/more)가 그대로 있고, 폰에선 채팅 자리 목록 줄 · ⌘K 「모든 화면」으로 간다', () => {
    const keys = PHONE_TABS.map((t) => t.key as string);
    expect(keys).not.toContain('work');
    expect(keys).not.toContain('more');
    expect(sidebarItem('board').path).toBe('flow');
    expect(ALL_SCREENS_ITEM.path).toBe('/more');
    expect(PHONE_TABS.map((t) => resolveTabHref(t, dest, {}, same))).not.toContain(ALL_SCREENS_ITEM.path);
  });

  it('⭐«결재»는 폰에서 탭이 아니라 «홈»이 품는다 — 사이드바에는 «결재» 항목(/inbox?tab=gates)이 그대로 있고 폰 탭에는 대응 탭이 없다', () => {
    expect(PHONE_TABS.some((t) => (t.key as string) === 'approvals')).toBe(false);
    expect(sidebarItem('inbox').path).toBe('/inbox?tab=gates');
  });
});
