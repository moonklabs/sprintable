import type { ProofState } from '@/components/proof-capsule/proof-capsule';

/**
 * 감사 로그의 원시 action 문자열(예: story.status_changed, gate.rejected)을 Proof Capsule의
 * 4-state 어휘로 매핑. BE가 action에 구조화된 severity를 안 주므로(no-fiction: 있는 문자열만
 * 근거) 키워드 휴리스틱으로 근사 — 진짜 정책위반/kill(violat/denied/fail/error)만 red로
 * 명확히 구분한다. reject는 red에서 제외(거부=학습 신호이지 실패가 아님, amber로 완화).
 * block도 red에서 제외(substring이 story.unblocked 같은 긍정 케이스까지 오탐매치하고,
 * "막힘=amber" 규율과도 충돌하므로 amber로 완화). 나머지는 성공>진행>중립 우선순위로 분류.
 */
export function deriveAuditProofState(action: string): ProofState {
  const a = action.toLowerCase();
  if (/violat|denied|fail|error/.test(a)) return 'red';
  if (/complet|approv|creat|done|merged|resolv|confirm/.test(a)) return 'green';
  if (/start|chang|progress|trigger|assign|updat|claim/.test(a)) return 'blue';
  return 'amber';
}
