/**
 * story #4003(E-UX-OVERHAUL·셸 통합 2/N) — 3998 결함②(v3 최소 nav·레거시 sidebar가
 * 같은 라벨(오늘/대화/연결·규칙)을 서로 다른 목적지로 보냄) 근본 처방의 단일 소스.
 * 4002 그라운딩에서 확認한 대로, v3 3화면(today-v3/chat-v3/connect-rules-v3)이 각자
 * NAV_ITEMS 손 배열을 들고 서로의 갱신을 못 따라잡은 게 원인 — 여기 이 순수 함수
 * 하나가 "플래그 조합 → 목적지" 결정을 전담하고, 레거시 app-sidebar.tsx가 이 함수를
 * 그대로 가져다 쓴다(복붙 규칙 0, AC2). v3 3화면 자신의 로컬 배열을 이 모듈로
 * 교체하는 건 3/N(story #4004, v3 PR 착지 뒤) 스코프 — 그 파일들은 develop에 아직
 * 없어(미착지 PR 4365·4370·4376에만 존재) 이 카드에서 손대지 않는다.
 *
 * 「일감」·「결과」는 여기 없다: 「일감」은 work-list(story #3844)가 이미 develop에
 * 있고 어느 플래그에도 안 걸려 org/project 문맥만으로 해소되는 resource-kind
 * 경로라(app-sidebar.tsx의 resourceLink('work-list', WORKSPACE_FRAME_TAB_PATHS)로
 * 직접 처리, 이 모듈이 다루면 resourceLink의 org/project 접두 로직을 복붙하게 된다 —
 * AC2가 금지하는 그 중복) 이 모듈의 스코프 밖이다. 「결과」는 플래그 무관 고정 경로
 * (/organization/insights-board, v3/레거시 둘 다 이미 동일)라 애초에 분기가 없다.
 */

export interface NavV3Flags {
  todayV3Enabled: boolean;
  chatV3Enabled: boolean;
  connectRulesV3Enabled: boolean;
}

export interface NavV3Destinations {
  /** 「오늘」 — ON: /today(story #3962) · OFF: /org-briefing(기존 「지금」 존) */
  today: string;
  /** 「대화」 — ON: /chat(story #3972) · OFF: /chats(기존 챗 center) */
  chats: string;
  /**
   * 「연결·규칙」 — ON: /connect-rules(story #3982, 통합 화면) · OFF: null(항목 자체를
   * 안 낸다 — 레거시는 지금처럼 「채널 연결」·「콘텐츠 규칙」 2항목을 그대로 유지,
   * 「옛 진입점 지우지 않는다」 원칙).
   */
  connectRules: string | null;
}

export function resolveNavV3Destinations(flags: NavV3Flags): NavV3Destinations {
  return {
    today: flags.todayV3Enabled ? '/today' : '/org-briefing',
    chats: flags.chatV3Enabled ? '/chat' : '/chats',
    connectRules: flags.connectRulesV3Enabled ? '/connect-rules' : null,
  };
}
