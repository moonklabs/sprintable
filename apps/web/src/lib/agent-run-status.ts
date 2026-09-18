// story #3689(3680 후속, 유나 確定) — agent-runs-list.tsx·agent-run-detail.tsx가
// 각자 status→{i18n 키, 배지 variant} 맵을 들고 있었다(3680에서 둘 다 손댐) —
// 같은 사실은 한 자리에서만 말한다. 순서는 목록 필터 드롭다운 노출 순서.
//
// ⛔ warning(미완)과 destructive(실패)는 tint 밝기가 거의 같다(라 1.04·다 1.08 —
// 색맹 조건에선 붙는다) — 구별을 색상이 하고 있으므로 배지에 낱말(「미완」·「실패」)
// 이 항상 함께 서는 것이 전제다. 아이콘만 남기거나 글자를 지우는 변형 금지.
export const AGENT_RUN_STATUS_ORDER = [
  'completed',
  'hitl_pending',
  'failed',
  'running',
  'queued',
  'held',
  'abandoned',
] as const;

export type AgentRunStatus = (typeof AGENT_RUN_STATUS_ORDER)[number];

export type AgentRunStatusBadgeVariant = 'success' | 'destructive' | 'info' | 'outline' | 'secondary' | 'warning';

export const AGENT_RUN_STATUS_BADGE_VARIANT: Record<AgentRunStatus, AgentRunStatusBadgeVariant> = {
  completed: 'success',
  hitl_pending: 'secondary',
  failed: 'destructive',
  running: 'info',
  queued: 'outline',
  held: 'secondary',
  // story #3689(유나 確定 2026-09-08) — «끝맺지 못함(미완)»과 «끝난 잘못됨(실패)»은
  // 다른 사실이라 다른 색. secondary는 「사람 확인 대기·보류」와 얼굴이 겹치고,
  // outline은 「모르는 상태」 폴백과 겹쳐 둘 다 기각(유나 근거).
  abandoned: 'warning',
};

// story #3689 CHANGES(카디르 QA, PO 페드루 처방 2026-09-08) — plain object 인덱싱
// 뒤 `??`만으로는 own-property가 아닌 status(constructor·toString·__proto__ 등
// Object.prototype 체인)에서 값이 새어나온다(`??`는 null/undefined만 폴백,
// 프로토타입 상속값은 undefined가 아니다) — "모르는 status는 outline" 계약을
// Object.hasOwn으로 먼저 지킨 뒤에만 조회한다.
export function agentRunStatusBadgeVariant(status: string): AgentRunStatusBadgeVariant {
  if (!Object.hasOwn(AGENT_RUN_STATUS_BADGE_VARIANT, status)) return 'outline';
  return (AGENT_RUN_STATUS_BADGE_VARIANT as Record<string, AgentRunStatusBadgeVariant>)[status];
}
