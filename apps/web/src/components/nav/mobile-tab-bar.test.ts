// story 5031 (C1 4단계) — 하단 탭은 웹 아이콘 막대와 같은 «1뎁스 넷»: 홈(today) · 채팅(chat) · 에이전트(agents) · 설정(settings). 일감 · 전체 탭은 없다 — 일감은 채팅 자리의 목록 줄이고 «전체»(/more)는 상단 막대 검색 → ⌘K 「모든 화면」이다.
// (옛 story #4885 폰 탭 넷 = 홈 · 대화 · 일감 · 전체. «결재» 탭이 없고 결재 경로는 «홈»이 품는 것은 그대로.)
// story #1991(navigate 불안정 1차 근원 B) — 하단 탭 active 판정 회귀가드. getActiveTabKey는 홈 · 채팅의 플래그별 목적지를 먼저 보고, 그 밖은 depth1ForPath(nav-placement.json — 웹 아이콘 막대가 켜는 것과 같은 함수)가 정한다.
// 셸 밖 화면(/connect-rules · /login 등)과 모르는 경로는 어느 탭도 안 켠다(null).
import { describe, expect, it } from 'vitest';
import { NAV_GROUPS, CHAT_CENTER_ITEM } from '@/lib/nav-config';
import { getActiveTabKey, PHONE_TABS } from './mobile-tab-bar';
import { WORKSPACE_FRAME_TAB_PATHS } from '@/components/workspace/workspace-frame-tabs';

describe('getActiveTabKey', () => {
  it('/{ws}/{proj}/flow(보드)는 chat — 일감은 채팅 자리의 목록 줄이다(story 5031 · 옛 story #2224 일감 탭 목적지)', () => {
    expect(getActiveTabKey('/qa-org/qa-proj/flow')).toBe('chat');
  });

  // 실제 동작: bare /flow(proxy 301 전 형태)는 ws/proj가 없는 flat 경로라 depth1ForPath가 못 알아본다 → null. 탭 막대는 목록 칸과 달리 «활성 카탈로그 항목 대체 판정»을 안 한다.
  it('bare /flow는 null — ws/proj 없는 flat 경로는 자리 표가 못 알아본다(proxy가 301로 /{ws}/{proj}/flow에 보낸 뒤엔 chat)', () => {
    expect(getActiveTabKey('/flow')).toBeNull();
  });

  it('/glance(옛 라우트)는 이제 어느 탭도 안 켠다(null) — 옛 «일감» 흡수 사라짐', () => {
    expect(getActiveTabKey('/glance')).toBeNull();
    expect(getActiveTabKey('/glance/foo')).toBeNull();
  });

  it('⭐/org-briefing(홈 화면)은 today', () => {
    expect(getActiveTabKey('/org-briefing')).toBe('today');
  });

  it('⭐«결재» 탭이 없어졌다 — /inbox 정확일치와 게이트 상세(/gates/{id})는 «홈»이 품는다(#1951 parentTab=/inbox 매핑은 그대로 · 결재 열기 손 수 3 → 2)', () => {
    expect(getActiveTabKey('/inbox')).toBe('today');
    expect(getActiveTabKey('/gates/7d0fc67b-d6c2-4767-a156-1bcf7c786ad0')).toBe('today');
  });

  // story #4016 CHANGES — /inbox 하위 경로(/inbox/x)는 정확일치만 인식한다. 하위까지 넓히는 헬퍼 오용 방지. story 5031: 등록 안 된 경로라 «전체»(more)가 아니라 어느 탭도 안 켠다(null).
  it('/inbox 하위 경로(/inbox/x)는 today가 아니다(null)', () => {
    expect(getActiveTabKey('/inbox/x')).not.toBe('today');
    expect(getActiveTabKey('/inbox/x')).toBeNull();
  });

  it('/chats 및 대화 상세(/chats/{id})는 chat', () => {
    expect(getActiveTabKey('/chats')).toBe('chat');
    expect(getActiveTabKey('/chats/abc123')).toBe('chat');
  });

  it('프로젝트 영역(goals · loops · docs)은 chat — 채팅 자리의 목록 줄 · 상세', () => {
    expect(getActiveTabKey('/qa-org/qa-proj/goals/abc')).toBe('chat');
    expect(getActiveTabKey('/qa-org/qa-proj/loops/abc')).toBe('chat');
    expect(getActiveTabKey('/qa-org/qa-proj/docs')).toBe('chat');
  });

  it('조직 영역은 자리별로 갈린다: 에이전트(/organization/workforce · 상세) · 설정(/settings · members · channels)', () => {
    expect(getActiveTabKey('/organization/workforce')).toBe('agents');
    expect(getActiveTabKey('/organization/workforce/abc')).toBe('agents');
    expect(getActiveTabKey('/settings')).toBe('settings');
    expect(getActiveTabKey('/organization/members')).toBe('settings');
    expect(getActiveTabKey('/organization/channels')).toBe('settings');
  });

  it('문서 상세(/{ws}/{proj}/docs/[slug])는 chat — 채팅 자리 상세', () => {
    expect(getActiveTabKey('/qa-org/qa-proj/docs/my-doc')).toBe('chat');
  });

  it('/more 자기 자신은 홈 자리(today) — «전체»는 탭이 아니라 ⌘K 「모든 화면」 줄이다', () => {
    expect(getActiveTabKey('/more')).toBe('today');
  });

  it('홈 자리 화면(결과 보드 · 활동 · 루프 큐)은 today · 셸 밖 화면(/connect-rules · /login)과 모르는 경로는 null', () => {
    expect(getActiveTabKey('/organization/insights-board')).toBe('today');
    expect(getActiveTabKey('/activity')).toBe('today');
    expect(getActiveTabKey('/loop-queue')).toBe('today');
    expect(getActiveTabKey('/connect-rules')).toBeNull();
    expect(getActiveTabKey('/login')).toBeNull();
    expect(getActiveTabKey('/no-such-screen')).toBeNull();
  });
});

// story 5031 — 탭 세트의 모양 한 곳: 홈 · 채팅 · 에이전트 · 설정. 되돌리면(일감 · 전체 · 결재 탭을 다시 넣거나 순서를 바꾸면) RED.
describe('PHONE_TABS — story 5031 (폰 탭 넷 = 웹 아이콘 막대와 같은 넷)', () => {
  it('⭐키와 순서: 홈(today) · 채팅(chat) · 에이전트(agents) · 설정(settings) — 일감(work) · 전체(more) · 결재(approvals) 탭 없음', () => {
    expect(PHONE_TABS.map((t) => t.key)).toEqual(['today', 'chat', 'agents', 'settings']);
  });

  it('각 탭은 그 자리의 첫 화면에 착지한다(플래그 OFF): 홈 /org-briefing · 채팅 /chats · 에이전트 /organization/workforce · 설정 /settings', () => {
    const href = (key: string) => PHONE_TABS.find((t) => t.key === key)?.href;
    expect(href('today')).toBe('/org-briefing');
    expect(href('chat')).toBe('/chats');
    expect(href('agents')).toBe('/organization/workforce');
    expect(href('settings')).toBe('/settings');
  });

  // 위 값 하드코딩 + getActiveTabKey 값 하드코딩이 «서로 안 만나서» 어긋나지 않게 — 탭 자신의 href를 판정기에 되먹이는 왕복(값을 또 하드코딩하지 않음).
  it('각 탭의 href는 getActiveTabKey를 다시 먹였을 때 자기 자신의 key로 돌아온다 — 왕복 회귀가드', () => {
    for (const tab of PHONE_TABS) {
      const pathnameOnly = tab.href.split('?')[0]!;
      expect(getActiveTabKey(pathnameOnly)).toBe(tab.key);
    }
  });
});

// story #3824 CHANGES②(페드루 PO 確定 2026-09-13 09:01Z, 카디르 QA 실측 09:49Z 후속) → story 5031 — 렌더 텍스트 대조(mobile-tab-bar-badge.test.tsx)만으론 "labelKey 자체를 공유한다"는
// 재발방지 취지를 구조적으로 못 잠근다. 이 스위트는 PHONE_TABS 데이터 자체의 namespace·labelKey 필드를 직접 잠가 "같은 키를 쓴다"를 구조로 고정한다.
describe('PHONE_TABS — labelKey 공유 회귀가드(재발 방지)', () => {
  it('⭐네 탭은 전부 nav 네임스페이스의 zoneNow · depth1Chat · workforce · settings를 그대로 공유한다(문구 값이 아니라 labelKey 자체 — 웹 아이콘 막대와 한 낱말)', () => {
    const tab = (key: string) => PHONE_TABS.find((t) => t.key === key)!;
    expect([tab('today').namespace, tab('today').labelKey]).toEqual(['nav', 'zoneNow']);
    expect([tab('chat').namespace, tab('chat').labelKey]).toEqual(['nav', 'depth1Chat']);
    expect([tab('agents').namespace, tab('agents').labelKey]).toEqual(['nav', 'workforce']);
    expect([tab('settings').namespace, tab('settings').labelKey]).toEqual(['nav', 'settings']);
  });

  it('mobileTabBar 자기 네임스페이스를 쓰는 탭은 없다(전체 탭이 사라져 모든 이름이 nav에서 온다)', () => {
    expect(PHONE_TABS.filter((t) => (t.namespace as string) !== 'nav')).toEqual([]);
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
  it.each([...PHONE_TABS])('$key 탭 — 사이드바에 같은 목적지 항목이 있고 labelKey가 같다(채팅만 예외: 웹 막대 이름 depth1Chat)', (tab) => {
    const tabResource = normalizeResourcePath(tab.href.split('?')[0]!);
    const matching = SIDEBAR_STATIC_ITEMS.find((item) => {
      const itemResource = item.kind === 'resource' ? item.path : normalizeResourcePath(item.path);
      return itemResource === tabResource;
    });
    // story 5031 — 탭 넷(홈 · 채팅 · 에이전트 · 설정)은 전부 사이드바에 같은 목적지 항목이 있다(탭 «전체»가 없어져 «예외 없음»).
    expect(matching, `${tab.key} 탭이 사이드바 어느 항목과도 목적지가 안 겹침(예상 밖) — 그라운딩 재확認 필요`).toBeDefined();
    if (tab.key === 'chat') {
      // 채팅 탭 이름은 웹 아이콘 막대와 같은 nav.depth1Chat(「채팅」) — 사이드바 chats(「대화」)와는 일부러 다르다.
      expect(tab.labelKey).toBe('depth1Chat');
      expect(matching!.labelKey).toBe('chats');
      return;
    }
    expect(
      tab.labelKey,
      `${tab.key} 탭(labelKey=${tab.labelKey})과 사이드바 「${matching!.labelKey}」(같은 목적지 ${tabResource})가 이름이 다름`,
    ).toBe(matching!.labelKey);
  });
});

// story #4278(민 기기 점검 4번) → story 5031 — 「일감」 위 줄(WorkspaceFrameTabs)의 여섯 화면은 이제 탭바에서 «채팅» 자리를 켠다(일감 탭이 없다). 표는 SSOT(WORKSPACE_FRAME_TAB_PATHS)를 그대로 돈다 — 탭이 늘면 이 테스트도 늘어난다.
// 뮤테이션: 자리 판정(depth1ForPath)을 빼면 여섯 줄이 null로 RED. bare `/{path}`(ws/proj 없는 flat · proxy 301 전 형태)는 자리 표가 못 알아봐 null이다(실제 동작).

describe('경로 → 탭 — 「일감」 위 줄 전부(story #4278 · 5031)', () => {
  const V3_ON = { todayV3Enabled: true, chatV3Enabled: true, connectRulesV3Enabled: true };

  it.each(WORKSPACE_FRAME_TAB_PATHS.map((p) => [p]))('⭐/{ws}/{proj}/%s — 플래그와 무관하게 «채팅»(chat) 자리', (path) => {
    const pathname = `/qa-org/qa-proj/${path}`;
    expect(getActiveTabKey(pathname), pathname).toBe('chat');
    expect(getActiveTabKey(pathname, V3_ON), pathname).toBe('chat');
  });

  it.each(WORKSPACE_FRAME_TAB_PATHS.map((p) => [p]))('bare /%s(ws/proj 없는 flat)는 어느 탭도 안 켠다(null) — 실제 동작', (path) => {
    expect(getActiveTabKey(`/${path}`), path).toBeNull();
  });

  it('표 자체: 여섯(목록 · 보드 · 스프린트 · 에픽 · 회고 · 가설) — 카드의 다섯 + 보드', () => {
    expect([...WORKSPACE_FRAME_TAB_PATHS].sort()).toEqual(['epics', 'flow', 'hypotheses', 'retro', 'sprints', 'work-list']);
  });
});
