// story #4885(폰 탭 넷) — 하단 탭은 플래그 없이 하나: 홈(today) · 대화(chat) · 일감(work) · 전체(more). «결재» 탭은 없고 결재 경로는 «홈»이 품는다.
// story #1991(navigate 불안정 1차 근원 B) — 하단 4탭 active 판정 회귀가드. 기존 isTabActive는
// 4탭 href 자체+직계 하위만 인식해 gate/doc/story 상세·프로젝트/org 영역(board/goals/loops/
// organization/settings 등, #1958 "전체" 스텁 목록 그대로)이 전부 회색이었다. getActiveTabKey가
// #1951 매니페스트 SSOT(상세→parentTab)를 그대로 재사용해 정확히 판정하는지 고정.
import { describe, expect, it } from 'vitest';
import { NAV_GROUPS, CHAT_CENTER_ITEM } from '@/lib/nav-config';
import { getActiveTabKey, PHONE_TABS } from './mobile-tab-bar';
import { WORKSPACE_FRAME_TAB_PATHS } from '@/components/workspace/workspace-frame-tabs';

describe('getActiveTabKey', () => {
  it('/{ws}/{proj}/flow 및 하위 경로는 work(일감) — story #2224, 일감 탭의 목적지', () => {
    expect(getActiveTabKey('/qa-org/qa-proj/flow')).toBe('work');
    expect(getActiveTabKey('/qa-org/qa-proj/flow/anything')).toBe('work');
  });

  it('bare /flow(+하위)도 work — 탭을 누른 순간(proxy.ts 301 착지 前)엔 pathname이 이 형태다', () => {
    expect(getActiveTabKey('/flow')).toBe('work');
    expect(getActiveTabKey('/flow/anything')).toBe('work');
  });

  it('/glance 및 하위 경로도 계속 work(옛 라우트 — 리다이렉트 경유 도착 대비)', () => {
    expect(getActiveTabKey('/glance')).toBe('work');
    expect(getActiveTabKey('/glance/foo')).toBe('work');
  });

  it('⭐/org-briefing(홈 화면)은 today', () => {
    expect(getActiveTabKey('/org-briefing')).toBe('today');
  });

  it('⭐«결재» 탭이 없어졌다 — /inbox 정확일치와 게이트 상세(/gates/{id})는 «홈»이 품는다(#1951 parentTab=/inbox 매핑은 그대로 · 결재 열기 손 수 3 → 2)', () => {
    expect(getActiveTabKey('/inbox')).toBe('today');
    expect(getActiveTabKey('/gates/7d0fc67b-d6c2-4767-a156-1bcf7c786ad0')).toBe('today');
  });

  // story #4016 CHANGES — /inbox 하위 경로(/inbox/x)는 정확일치만 인식한다(알림 상세 같은 /inbox/x는 «전체» 소관). 하위까지 넓히는 헬퍼 오용 방지.
  it('/inbox 하위 경로(/inbox/x)는 today가 아니라 more다', () => {
    expect(getActiveTabKey('/inbox/x')).toBe('more');
  });

  it('/chats 및 대화 상세(/chats/{id})는 chat', () => {
    expect(getActiveTabKey('/chats')).toBe('chat');
    expect(getActiveTabKey('/chats/abc123')).toBe('chat');
  });

  it('프로젝트/org 영역(board·goals·loops·organization·settings 등)은 more — «전체» 목록과 정합', () => {
    expect(getActiveTabKey('/board')).toBe('more');
    expect(getActiveTabKey('/qa-org/qa-proj/board')).toBe('more');
    expect(getActiveTabKey('/qa-org/qa-proj/goals/abc')).toBe('more');
    expect(getActiveTabKey('/qa-org/qa-proj/loops/abc')).toBe('more');
    expect(getActiveTabKey('/organization/workforce/abc')).toBe('more');
    expect(getActiveTabKey('/settings')).toBe('more');
  });

  it('문서 상세(/{ws}/{proj}/docs/[slug])는 more — #1951 parentTab=/more 매핑과 정합', () => {
    expect(getActiveTabKey('/qa-org/qa-proj/docs/my-doc')).toBe('more');
  });

  it('/more 자기 자신도 more', () => {
    expect(getActiveTabKey('/more')).toBe('more');
  });
});

// story #4885 — 탭 세트의 모양 한 곳: 홈 · 대화 · 일감 · 전체, 결재 탭 0. 되돌리면(결재 탭을 다시 넣거나 순서를 바꾸면) RED.
describe('PHONE_TABS — story #4885 (폰 탭 넷)', () => {
  it('⭐키와 순서: 홈(today) · 대화(chat) · 일감(work) · 전체(more) — 결재(approvals) 탭 없음', () => {
    expect(PHONE_TABS.map((t) => t.key)).toEqual(['today', 'chat', 'work', 'more']);
  });

  it('각 탭은 지금 서 있는 화면에 착지한다(플래그 OFF): 홈 /org-briefing · 대화 /chats · 일감 /flow · 전체 /more', () => {
    const href = (key: string) => PHONE_TABS.find((t) => t.key === key)?.href;
    expect(href('today')).toBe('/org-briefing');
    expect(href('chat')).toBe('/chats');
    expect(href('work')).toBe('/flow');
    expect(href('more')).toBe('/more');
  });

  // 위 값 하드코딩 + getActiveTabKey 값 하드코딩이 «서로 안 만나서» 어긋나지 않게 — 탭 자신의 href를 판정기에 되먹이는 왕복(값을 또 하드코딩하지 않음).
  it('각 탭의 href는 getActiveTabKey를 다시 먹였을 때 자기 자신의 key로 돌아온다 — 왕복 회귀가드', () => {
    for (const tab of PHONE_TABS) {
      const pathnameOnly = tab.href.split('?')[0]!;
      expect(getActiveTabKey(pathnameOnly)).toBe(tab.key);
    }
  });
});

// story #3824 CHANGES②(페드루 PO 確定 2026-09-13 09:01Z, 카디르 QA 실측 09:49Z 후속) —
// 렌더 텍스트 대조(mobile-tab-bar-badge.test.tsx)만으론 "labelKey 자체를 공유한다"는
// 재발방지 취지를 구조적으로 못 잠근다(카디르 뮤테이션: namespace/labelKey를 옛
// mobileTabBar.now/chat로 되돌려도 그 파일의 27개 테스트가 그대로 GREEN이었다 — 렌더
// 텍스트 대조가 실은 이 축을 안 지나가는 경로로도 통과할 여지가 있었다는 뜻). 이 스위트는
// TABS 데이터 자체의 namespace·labelKey 필드를 직접 잠가 "같은 키를 쓴다"를 구조로 고정한다.
describe('PHONE_TABS — story #3824 CHANGES② labelKey 공유 회귀가드(재발 방지, 카디르 QA 후속)', () => {
  it('⭐홈 · 대화 · 일감 탭은 nav 네임스페이스의 zoneNow · chats · zoneDev를 그대로 공유한다(문구 값이 아니라 labelKey 자체 — 사이드바와 한 낱말)', () => {
    const tab = (key: string) => PHONE_TABS.find((t) => t.key === key)!;
    expect([tab('today').namespace, tab('today').labelKey]).toEqual(['nav', 'zoneNow']);
    expect([tab('chat').namespace, tab('chat').labelKey]).toEqual(['nav', 'chats']);
    expect([tab('work').namespace, tab('work').labelKey]).toEqual(['nav', 'zoneDev']);
  });

  it('전체 탭은 mobileTabBar 자기 네임스페이스(more)다', () => {
    const moreTab = PHONE_TABS.find((t) => t.key === 'more');
    expect(moreTab?.namespace).toBe('mobileTabBar');
    expect(moreTab?.labelKey).toBe('more');
  });
});

// story #4020(페드루 PO 확定 2026-09-17) — 3824가 "탭 바 「지금」과 사이드바 「오늘」은
// 같은 화면"이라는 틀린 전제로 now 탭의 labelKey를 zoneNow로 공유시켰다(실제 목적지는
// /flow=사이드바 「일감」). 재발 방지는 "이 두 자리가 같은 화면이라 치고 이름을 맞춘다"가
// 아니라 "목적지가 실제로 같은 자리끼리만 이름을 맞춘다"는 불변식이어야 한다 — 라벨을
// 하드코딩 대조하지 않고, 목적지(href/path 정규화)가 같은 사이드바 항목을 찾아 그
// labelKey와 대조한다.
function normalizeResourcePath(path: string): string {
  return path.replace(/^\//, '');
}

const SIDEBAR_STATIC_ITEMS = [...NAV_GROUPS.flatMap((g) => g.items), CHAT_CENTER_ITEM];

describe('PHONE_TABS — story #4020 AC2 목적지 기준 labelKey 대조(같은 화면=같은 이름, 다르면 같이 두지 않는다)', () => {
  it.each([...PHONE_TABS])('$key 탭 — 사이드바에 같은 목적지 항목이 있으면 labelKey가 같다(없으면 전체만 허용)', (tab) => {
    const tabResource = normalizeResourcePath(tab.href.split('?')[0]!);
    const matching = SIDEBAR_STATIC_ITEMS.find((item) => {
      const itemResource = item.kind === 'resource' ? item.path : normalizeResourcePath(item.path);
      return itemResource === tabResource;
    });
    if (!matching) {
      // 전체(/more)는 사이드바 맨 아래 «전체»(ALL_SCREENS_ITEM)가 따로 가진다 — NAV_GROUPS 항목은 아니다.
      expect(['more'], `${tab.key} 탭이 사이드바 어느 항목과도 목적지가 안 겹침(예상 밖) — 그라운딩 재확認 필요`).toContain(tab.key);
      return;
    }
    expect(
      tab.labelKey,
      `${tab.key} 탭(labelKey=${tab.labelKey})과 사이드바 「${matching.labelKey}」(같은 목적지 ${tabResource})가 이름이 다름`,
    ).toBe(matching.labelKey);
  });
});

// story #4278(민 기기 점검 4번) — 「일감」 위 줄(WorkspaceFrameTabs)의 여섯 화면 전부에서 탭바가 «일감»을 켠다. 예전엔 보드(/flow)만
// «일감»이고 목록 · 스프린트 · 에픽 · 회고 · 가설 다섯은 «전체»였다(사이드바는 #3844에서 이미 같은 목록으로 고침). 표는 SSOT
// (WORKSPACE_FRAME_TAB_PATHS)를 그대로 돈다 — 탭이 늘면 이 테스트도 늘어난다. 뮤테이션: isWorkPath를 dest.work.path 한 조각으로
// 되돌리면 다섯 줄이 «more»로 RED.

describe('경로 → 탭 — 「일감」 위 줄 전부(story #4278)', () => {
  const V3_ON = { todayV3Enabled: true, chatV3Enabled: true, connectRulesV3Enabled: true };

  it.each(WORKSPACE_FRAME_TAB_PATHS.map((p) => [p]))('⭐/{ws}/{proj}/%s(+하위) — 플래그와 무관하게 «일감»(work)', (path) => {
    for (const pathname of [`/qa-org/qa-proj/${path}`, `/qa-org/qa-proj/${path}/abc`, `/${path}`]) {
      expect(getActiveTabKey(pathname), pathname).toBe('work');
      expect(getActiveTabKey(pathname, V3_ON), pathname).toBe('work');
    }
  });

  it('표 자체: 여섯(목록 · 보드 · 스프린트 · 에픽 · 회고 · 가설) — 카드의 다섯 + 보드', () => {
    expect([...WORKSPACE_FRAME_TAB_PATHS].sort()).toEqual(['epics', 'flow', 'hypotheses', 'retro', 'sprints', 'work-list']);
  });
});
