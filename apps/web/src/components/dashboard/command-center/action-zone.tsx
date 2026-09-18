import type { useTranslations } from 'next-intl';
import { type AttentionItem } from './types';
import { gateTypeLabel } from '@/lib/gate-type-label';

// story #3918 — 이 파일이 그리던 ActionZone(command-center) 컴포넌트·QueueRow·WaitingRow·
// AttentionRow는 삭제(story #3179가 /dashboard 자체를 이미 /chats로 리다이렉트해 실 소비처
// 0 — 은퇴 주소 생존 클래스). 아래 세 순수 함수만 남는다: chat 「지금」 스트립
// (derive-now-strip.ts, story #3177 S3a)이 "두 벌 금지" 원칙으로 그대로 재사용 中이라
// (attentionEntityLabel/attentionDayCount/attentionDetailText — 3곳 동기화 경계, 그
// 파일 주석 참고) 파일 자체는 유지한다.

// story #3150 — AttentionItem 7종(types.ts 참조) 공통 식별명 추출. agent_stuck만 id 재해소가
// 필요(entity_id가 멤버/에픽 id)하고, 나머지 6종은 BE(#2538 계약)가 title/statement/
// blocked_story_title을 이미 직접 싣는다 — 그 필드를 그대로 쓰면 된다(재해소 시도 자체가
// 이 버그의 원인이었다: resolveName이 멤버/에픽 id만 알아 story 스코프 항목에서 늘 null).
// story #3177(S3a) — chat 「지금」 스트립이 이 계산을 재사용한다(§1b·두 벌 금지). export.
export function attentionEntityLabel(
  item: AttentionItem,
  resolveName: (id: string | null | undefined) => string | null,
  epicTitles: Record<string, string>,
): string {
  switch (item.type) {
    case 'agent_stuck':
      return resolveName(item.entity_id) ?? epicTitles[item.entity_id] ?? item.entity_type;
    case 'agent_auth_failure':
      return resolveName(item.member_id) ?? item.reason;
    case 'loop_overdue_goal':
    case 'loop_outcome_missing_goal':
      return item.title;
    case 'unanswered_blocker':
      return item.blocked_story_title;
    case 'hypothesis_falsified':
    case 'loop_overdue_hypothesis':
      return item.statement;
  }
}

// story #3150 — 부제 텍스트. agent_stuck은 기존 게이트 카피 그대로 유지(회귀 0). 나머지는
// BE가 실어 보내는 경과일수 필드(타입마다 이름이 다르다 — age_days/falsified_days/
// overdue_days/done_days) 중 있는 것을 그대로 보여준다(no-fiction: 실측값만, 지어낸 사유
// 문구 0).
// story #3177(S3a) — 7종 중 5종(agent_stuck/agent_auth_failure 제외)의 경과일수 필드는
// 이름이 다르다(age_days/falsified_days/overdue_days/done_days) — 그 5종에 공통인 「일수」
// 하나로 추출해 재사용(§1b "attentionDayCount 재사용" 전제 — 두 벌 금지). agent_stuck/
// agent_auth_failure는 애초에 「일수」 개념이 없어(경과 timestamp·count가 별도 축) null.
export function attentionDayCount(item: AttentionItem): number | null {
  if (item.type === 'agent_stuck' || item.type === 'agent_auth_failure') return null;
  if (item.type === 'unanswered_blocker') return item.age_days;
  if (item.type === 'hypothesis_falsified') return item.falsified_days;
  if (item.type === 'loop_overdue_hypothesis' || item.type === 'loop_overdue_goal') return item.overdue_days;
  return item.done_days; // loop_outcome_missing_goal
}

// story #3177(S3a) — 「지금」 스트립도 같은 부제 텍스트를 쓴다(attentionEntityLabel/
// attentionDayCount와 같은 재사용 결 — no-fiction 문구 생성 로직을 두 벌 두지 않는다).
export function attentionDetailText(t: ReturnType<typeof useTranslations>, item: AttentionItem): string {
  if (item.type === 'agent_stuck') return t('ccAgentStuck', { gate: gateTypeLabel(t, item.gate_type) });
  if (item.type === 'agent_auth_failure') return t('ccAttentionAuthFailure', { count: item.failure_count });
  const days = attentionDayCount(item);
  return days != null ? t('ccAttentionDays', { days }) : t('ccAttentionGeneric');
}
