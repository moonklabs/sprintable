import type { ProofState } from '@/components/proof-capsule/proof-capsule';

/**
 * 감사 로그의 원시 action 문자열(예: story.status_changed, gate.rejected)을 Proof Capsule의
 * 4-state 어휘로 매핑. BE가 action에 구조화된 severity를 안 주므로(no-fiction: 있는 문자열만
 * 근거) 키워드 휴리스틱으로 근사 — 실패/거부/위반 계열만 red로 명확히 구분하고, 나머지는
 * 상태 우선순위(성공>진행>중립)로 완화 분류한다.
 */
export function deriveAuditProofState(action: string): ProofState {
  const a = action.toLowerCase();
  if (/fail|reject|violat|block|error|denied/.test(a)) return 'red';
  if (/complet|approv|creat|done|merged|resolv|confirm/.test(a)) return 'green';
  if (/start|chang|progress|trigger|assign|updat|claim/.test(a)) return 'blue';
  return 'amber';
}
