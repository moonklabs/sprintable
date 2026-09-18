// story #3806(Phase3·3-2 PR5, 정정3 — 페드루 PO 리뷰 2026-09-11 13:00Z 실측) — 봉인
// 목표(objective) 표시가 원시 enum 값("POST_ENGAGEMENT" 등)을 그대로 찍고 있었다(gate-
// evidence.tsx·boost-execution-control.tsx 둘 다 facts.adsObjective를 가공 없이 렌더).
// 유나 §절 §1 표가 요구하는 사람 낱말(참여/도달/트래픽)로 바꾸는 단일 지점 — i18n 키는
// boost-request-dialog.tsx의 select가 이미 쓰던 content 네임스페이스 `boostObjective_*`
// 그대로 재사용(새 낱말표 발명 0, 요청 폼·표시 두 자리가 같은 낱말을 쓴다는 것도 보장).
const OBJECTIVE_LABEL_KEYS: Record<string, string> = {
  POST_ENGAGEMENT: 'boostObjective_POST_ENGAGEMENT',
  REACH: 'boostObjective_REACH',
  LINK_CLICKS: 'boostObjective_LINK_CLICKS',
};

/** objective 원시값 → 사람 낱말. 미등재 값(미래 확장 등)은 원시값 그대로 폴백(지어내지 않는다). */
export function adsBoostObjectiveLabel(
  objective: string | null | undefined,
  tContent: (key: string) => string,
): string {
  if (!objective) return '';
  const key = OBJECTIVE_LABEL_KEYS[objective];
  return key ? tContent(key) : objective;
}
