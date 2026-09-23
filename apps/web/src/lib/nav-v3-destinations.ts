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
 * CHANGES(페드루 PO, PR#4386 첫 리뷰) — 첫 버전은 절대경로 문자열만 반환해 「일감」·
 * 「결과」를 스코프 밖으로 뺐는데, 그러면 4004에서 v3 세 화면이 또 손으로 정하게
 * 된다. **서술자**(`{kind, path}`)로 5항목 전부를 이 모듈이 정하고, resource-kind는
 * "org/project 접두가 필요한 상대 경로 조각"만 돌려줘 실제 접두는 호출부(레거시=
 * app-sidebar.tsx의 resourceLink, 4004=v3 화면의 동형 헬퍼)가 한다 — 접두 로직 자체는
 * 안 복붙(AC2).
 */

export interface NavV3Flags {
  todayV3Enabled: boolean;
  chatV3Enabled: boolean;
  connectRulesV3Enabled: boolean;
}

/** static = 그대로 href로 쓰는 절대경로. resource = org/project 접두가 필요한 조각(호출부의 resourceLink류가 해석). */
export type NavV3Destination =
  | { kind: 'static'; path: string }
  | { kind: 'resource'; path: string };

export interface NavV3Destinations {
  /** 「오늘」 — ON: /today(story #3962) · OFF: /org-briefing(기존 「지금」 존) */
  today: NavV3Destination;
  /** 「대화」 — ON: /chat(story #3972) · OFF: /chats(기존 챗 center) */
  chats: NavV3Destination;
  /**
   * 「일감」 — CHANGES: 어느 단일 v3 플래그에도 안 걸린 화면이라, 셋 중 **하나라도**
   * ON이면(=이 배치의 v3 전환이 시작됐다는 신호) work-list(story #3844, 시안 ③ 첫 탭)
   * 로, 셋 다 OFF(=지금 prod 상태)면 기존 flow 그대로 — 「플래그 전부 OFF=바이트
   * 동일」 불변식을 「일감」도 지킨다(1차 리뷰 CHANGES①: work-list 무조건 전환은
   * 착지 즉시 전 사용자 노출이라 반려됨).
   */
  work: NavV3Destination;
  /** 「결과」 — 플래그 무관 고정 경로(v3/레거시 둘 다 이미 /organization/insights-board 공용). */
  results: NavV3Destination;
  /**
   * 「연결·규칙」 — ON: /connect-rules(story #3982, 통합 화면) · OFF: null(항목 자체를
   * 안 낸다 — 레거시는 지금처럼 「채널 연결」·「콘텐츠 규칙」 2항목을 그대로 유지,
   * 「옛 진입점 지우지 않는다」 원칙).
   */
  connectRules: NavV3Destination | null;
  /**
   * 「결재」 — story #4016(페드루 PO 確定 2026-09-17) 추가. 모바일 탭 바 전용이던 고정
   * 경로(v3 3플래그 어디에도 안 걸림, results와 동형) — 이 모듈에 없으면 소비처(탭 바)가
   * 손으로 다시 박게 된다(AC1 「파일 안 경로 리터럴 0」).
   */
  approvals: NavV3Destination;
  /** 「전체」 — 위와 동형, 모바일 허브(더보기) 진입점. 플래그 무관 고정 경로. */
  more: NavV3Destination;
}

// prop이 안 넘어온 소비처(예: 테스트, navV3Flags 미배선 자리)의 안전한 기본값 —
// 전부 false = 지금 develop과 바이트 동일 경로(회귀 0 보장).
export const DEFAULT_NAV_V3_FLAGS: NavV3Flags = {
  todayV3Enabled: false,
  chatV3Enabled: false,
  connectRulesV3Enabled: false,
};

export function resolveNavV3Destinations(flags: NavV3Flags): NavV3Destinations {
  const anyV3Enabled = flags.todayV3Enabled || flags.chatV3Enabled || flags.connectRulesV3Enabled;
  return {
    today: { kind: 'static', path: flags.todayV3Enabled ? '/today' : '/org-briefing' },
    chats: { kind: 'static', path: flags.chatV3Enabled ? '/chat' : '/chats' },
    work: { kind: 'resource', path: anyV3Enabled ? 'work-list' : 'flow' },
    results: { kind: 'static', path: '/organization/insights-board' },
    connectRules: flags.connectRulesV3Enabled ? { kind: 'static', path: '/connect-rules' } : null,
    approvals: { kind: 'static', path: '/inbox?tab=gates' },
    more: { kind: 'static', path: '/more' },
  };
}

// story #4017(PO 확定 2026-09-17) — 본문 CTA(not-found·recruiter-client·content 목록류
// 등)·session-redirect.ts류가 "플래그 없으면 레거시 리터럴, 있으면 목적지 모듈"을 매번
// 반복하지 않게 순수 함수로 뺀다(React 의존 0 — dashboard-shell.tsx의 useChatsHref/
// useConnectRulesHref는 이 함수에 useDashboardContext().navV3Flags만 얹는 얇은 래퍼,
// 무거운 DashboardShell 의존 트리 없이 이 파일에서 직접 단위테스트 가능).
export function resolveChatsHref(flags: NavV3Flags | undefined): string {
  return flags ? resolveNavV3Destinations(flags).chats.path : '/chats';
}

// connectRules는 OFF일 때 목적지 모듈 자체가 null(사이드바 항목 자체를 안 그린다는 뜻)이라,
// 본문 CTA는 호출부가 자기 자리의 옛 목적지(채널 연결 화면 vs 콘텐츠 규칙 화면 — 자리마다
// 다름)를 legacyFallback으로 넘긴다.
export function resolveConnectRulesHref(flags: NavV3Flags | undefined, legacyFallback: string): string {
  if (!flags) return legacyFallback;
  const dest = resolveNavV3Destinations(flags);
  return dest.connectRules ? dest.connectRules.path : legacyFallback;
}

/**
 * story #4211 — `resource` 목적지(/{ws}/{proj}/{resource})의 링크 한 곳. 사이드바(app-sidebar resourceLink)와 모바일
 * 탭바가 같은 규칙을 쓴다(따로 두면 한쪽만 bare로 남는다 — 4211이 그 부류: 탭바만 bare `/flow`라 세션 의존 리다이렉트를
 * 매 탭 타고, 4557 전 301을 캐시한 기기는 옛 프로젝트로 갔다). 두 slug가 다 있을 때만 직접 경로, 하나라도 모르면 bare
 * `/{resource}`(미들웨어 안전망 — 로그인 직후 등 slug가 아직 없는 찰나).
 */
export function scopedResourceHref(resource: string, orgSlug: string | undefined, projectSlug: string | undefined): string {
  return orgSlug && projectSlug ? `/${orgSlug}/${projectSlug}/${resource}` : `/${resource}`;
}
