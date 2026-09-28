// story #4004 AC2 — 플래그 3개 8조합마다 공유 nav-item 목록(v3 셸 3화면이 공통으로
// 쓰는 NavV3ItemList)의 각 항목 목적지가 레거시 사이드바(resolveNavGroups/
// resolveChatCenterItem)의 같은 항목 목적지와 같다는 단언. mobile-tab-bar-sidebar-
// symmetric.test.ts와 동형 — 둘 다 resolveNavV3Destinations(#4003) 하나만 원본으로
// 삼는지를 값이 아니라 "같은 원본을 가리키는가"로 구조적으로 고정한다(drift 재발
// 방지, 4016 선례와 같은 규율). 「결재」·「전체」는 사이드바에 대응 항목이 없어
// mobile-tab-bar와 마찬가지로 대칭 대조 대상 밖(그라운딩은 mobile-tab-bar-sidebar-
// symmetric.test.ts 상단 주석 참고).
import { describe, expect, it } from 'vitest';
import { resolveNavGroups, resolveChatCenterItem } from '@/lib/nav-config';
import { resolveNavV3Destinations, type NavV3Flags } from '@/lib/nav-v3-destinations';

const COMBOS: NavV3Flags[] = [
  { todayV3Enabled: false, chatV3Enabled: false, connectRulesV3Enabled: false },
  { todayV3Enabled: true, chatV3Enabled: false, connectRulesV3Enabled: false },
  { todayV3Enabled: false, chatV3Enabled: true, connectRulesV3Enabled: false },
  { todayV3Enabled: false, chatV3Enabled: false, connectRulesV3Enabled: true },
  { todayV3Enabled: true, chatV3Enabled: true, connectRulesV3Enabled: false },
  { todayV3Enabled: true, chatV3Enabled: false, connectRulesV3Enabled: true },
  { todayV3Enabled: false, chatV3Enabled: true, connectRulesV3Enabled: true },
  { todayV3Enabled: true, chatV3Enabled: true, connectRulesV3Enabled: true },
];

function sidebarItemPath(flags: NavV3Flags, groupId: string, itemId: string): string {
  const group = resolveNavGroups(flags).find((g) => g.id === groupId);
  const item = group?.items.find((i) => i.id === itemId);
  if (!item) throw new Error(`사이드바 ${groupId} 그룹의 ${itemId} 항목을 찾지 못함(nav-config.ts 구조 변경?)`);
  return item.path;
}

describe('NavV3ItemList ↔ app-sidebar 대칭(story #4004 AC2) — 플래그 8조합', () => {
  it.each(COMBOS)('오늘(today) — org-briefing 항목과 같은 경로($todayV3Enabled/$chatV3Enabled/$connectRulesV3Enabled)', (flags) => {
    const dest = resolveNavV3Destinations(flags);
    expect(dest.today.path).toBe(sidebarItemPath(flags, 'now', 'org-briefing'));
  });

  it.each(COMBOS)('대화(chats) — CHAT_CENTER_ITEM과 같은 경로($todayV3Enabled/$chatV3Enabled/$connectRulesV3Enabled)', (flags) => {
    const dest = resolveNavV3Destinations(flags);
    expect(dest.chats.path).toBe(resolveChatCenterItem(flags).path);
  });

  it.each(COMBOS)('일감(work) — board 항목과 같은 리소스 조각($todayV3Enabled/$chatV3Enabled/$connectRulesV3Enabled)', (flags) => {
    const dest = resolveNavV3Destinations(flags);
    expect(dest.work.path).toBe(sidebarItemPath(flags, 'dev', 'board'));
  });

  it.each(COMBOS)('결과(results) — org-insights-board 항목과 같은 경로($todayV3Enabled/$chatV3Enabled/$connectRulesV3Enabled)', (flags) => {
    const dest = resolveNavV3Destinations(flags);
    expect(dest.results.path).toBe(sidebarItemPath(flags, 'results', 'org-insights-board'));
  });

  it.each(COMBOS)('연결·규칙(connectRules) — connectRulesV3Enabled일 때만 connect-rules-v3 항목과 같은 경로($todayV3Enabled/$chatV3Enabled/$connectRulesV3Enabled)', (flags) => {
    const dest = resolveNavV3Destinations(flags);
    if (!flags.connectRulesV3Enabled) {
      expect(dest.connectRules).toBeNull();
      return;
    }
    expect(dest.connectRules?.path).toBe(sidebarItemPath(flags, 'connect-rules', 'connect-rules-v3'));
  });

  // 양성대조 — 8조합에 실제로 ON 상태가 섞여 있음을 확認(전부 OFF 트리비얼 비교 방지).
  it('⭐8조합에 실제로 ON 상태가 섞여 있다(전부 OFF 트리비얼 비교가 아님)', () => {
    const todayPaths = new Set(COMBOS.map((f) => resolveNavV3Destinations(f).today.path));
    const workPaths = new Set(COMBOS.map((f) => resolveNavV3Destinations(f).work.path));
    expect(todayPaths.size).toBeGreaterThan(1);
    expect(workPaths.size).toBeGreaterThan(1);
  });
});
