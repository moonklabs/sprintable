/**
 * E-CANVAS C4-S8 — 정본화(canonicalize) 제안 상태 유도. 승인 자체는 새 UI 없이 기존
 * E-DG Decision Gate(`/inbox?tab=gates`)가 처리(§1 에이전트 제안/인간 승인 재사용) — 여기선
 * "이 버전에 이미 대기 중인 제안이 있나"만 gates 목록에서 읽어 뷰어의 제안 버튼/배지 상태를
 * 결정한다. BE `POST .../canonicalize`가 만드는 Gate는 `neutral_facts.version_number`에
 * 대상 버전을 담아 응답(routers/visual_artifacts.py) — 신규 필드 0.
 */

export interface CanonicalizeGateLookup {
  gate_type: string;
  status: string;
  neutral_facts: Record<string, unknown> | null;
}

/** artifact_canonicalize gate 중 status='pending'인 것의 대상 버전을 유도. 여럿이면 최신(최대) 채택. */
export function derivePendingCanonicalizeVersion(gates: CanonicalizeGateLookup[]): number | null {
  let result: number | null = null;
  for (const g of gates) {
    if (g.gate_type !== 'artifact_canonicalize' || g.status !== 'pending') continue;
    const v = g.neutral_facts?.['version_number'];
    if (typeof v !== 'number') continue;
    if (result === null || v > result) result = v;
  }
  return result;
}
