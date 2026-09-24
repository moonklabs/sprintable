// story #4016 AC3 — 플래그 8조합마다 모바일 탭 바의 각 탭 목적지 == 같은 키의 사이드바
// 목적지(4386의 8조합 표, nav-v3-destinations.test.ts와 동형 조합). now↔work·chat↔chats는
// 둘 다 사이드바(app-sidebar.tsx가 resolveNavGroups/resolveChatCenterItem으로 그리는
// 것)와 탭 바(resolveTabHref)가 같은 resolveNavV3Destinations 호출 결과를 나눠 쓰는지를
// 구조로 고정 — 값을 손으로 대조하지 않고 두 소비처가 "같은 원본"을 가리키는지를 본다
// (한쪽만 갱신되는 drift 재발 방지, PO 지적 2026-09-17 14:26Z). approvals·more는 사이드바에
// 대응 항목이 없다(그라운딩 확認 — app-sidebar.tsx·nav-config.ts에 `/inbox?tab=gates`·
// `/more` 리터럴 0건, 결재 배지는 카운트만 갖고 클릭 가능한 nav 항목이 아니다) — 대칭
// 대조 대상은 work·chats 2개뿐.
import { describe, expect, it } from 'vitest';
import { resolveNavGroups, resolveChatCenterItem } from '@/lib/nav-config';
import { resolveNavV3Destinations, type NavV3Flags } from '@/lib/nav-v3-destinations';
import { TABS, resolveTabHref } from './mobile-tab-bar';

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

function sidebarBoardResourcePath(flags: NavV3Flags): string {
  const devGroup = resolveNavGroups(flags).find((g) => g.id === 'dev');
  const boardItem = devGroup?.items.find((i) => i.id === 'board');
  if (!boardItem) throw new Error('사이드바 dev 그룹의 board 항목을 찾지 못함(nav-config.ts 구조 변경?)');
  return boardItem.path;
}

describe('mobile-tab-bar ↔ app-sidebar 대칭(story #4016 AC3) — 플래그 8조합', () => {
  it.each(COMBOS)('now 탭(work) — 사이드바 board 항목과 같은 리소스 조각($todayV3Enabled/$chatV3Enabled/$connectRulesV3Enabled)', (flags) => {
    const dest = resolveNavV3Destinations(flags);
    const nowTab = TABS.find((t) => t.key === 'now')!;
    const tabResourceFragment = resolveTabHref(nowTab, dest, {}, (h) => h).replace(/^\//, '');
    expect(tabResourceFragment).toBe(sidebarBoardResourcePath(flags));
  });

  it.each(COMBOS)('chat 탭 — 사이드바 CHAT_CENTER_ITEM과 같은 경로($todayV3Enabled/$chatV3Enabled/$connectRulesV3Enabled)', (flags) => {
    const dest = resolveNavV3Destinations(flags);
    const chatTab = TABS.find((t) => t.key === 'chat')!;
    expect(resolveTabHref(chatTab, dest, {}, (h) => h)).toBe(resolveChatCenterItem(flags).path);
  });

  // 양성 대조 — 위 두 시험이 실제로 뭔가를 검증하고 있는지(항상 true인 트리비얼 비교가
  // 아닌지) 8조합 중 최소 1건은 ON 상태(옛 값과 다름)를 포함함을 확認.
  it('⭐8조합에 실제로 ON 상태가 섞여 있다(전부 OFF 트리비얼 비교가 아님)', () => {
    const workPaths = new Set(COMBOS.map((f) => resolveNavV3Destinations(f).work.path));
    expect(workPaths.size).toBeGreaterThan(1);
  });
});
