/**
 * E-GLANCE 2D hero ProofCapsule 리치 렌더(story 04da0281) — 원래 `GET /api/v2/glance/hero?story_id=`
 * (#2099·d02082e1) envelope 소비였으나, story #2298/#2303(3단 웨이터폴 근절)로 그 fetch(웨이브③)
 * 자체가 없어졌다 — `?include=glance`의 `focal_story`(#2303, `services/glance.ts`의
 * `BeFocalStory`)가 같은 재료를 웨이브①에서 함께 실어온다(load-glance-data.ts가 조립).
 *
 * ⛔타입 셋(HeroGateEnvelope·HeroTrustMember·HeroEnvelope)은 `glance-hero.tsx` + 호출체인
 * (splitParticipants·heroProofState·buildEvidence·buildTrustSeal·synthesizeGateAction)이
 * **실제로 읽는 필드만** 남겼다(2026-07-29 그라운딩) — `story_id`·`claim`·`status`(envelope 쪽,
 * story.title/status를 대신 쓴다)·`gate.status`/`decision_basis`/`auto_decision_reason`·
 * `human_verified_by.member_id`/`role`은 화면이 안 읽어 뺐다. 파싱 함수(`parseHeroEnvelope` 등)도
 * 함께 삭제 — 소스가 이제 신뢰된 BE JSON 그대로라(load-glance-data.ts가 직접 조립) 방어적
 * unwrap이 더는 필요 없다.
 */

export interface HeroGateEnvelope {
  gate_type: string;
  requires_human: boolean;
}

export interface HeroTrustMember {
  name: string;
}

export interface HeroTrustEnvelope {
  self_reported: boolean;
  human_verified: boolean;
  human_verified_by: HeroTrustMember | null;
  human_verified_at: string | null;
}

export interface HeroEnvelope {
  proof_count: number;
  auto_verify: 'passed' | 'failed' | null;
  gate: HeroGateEnvelope | null;
  trust: HeroTrustEnvelope;
}

export interface HeroActionLabels {
  merge: string;
  decide: string;
  review: string;
}

/**
 * gate 구조필드 → action 라벨 FE 합성(BE는 표시문자열 안 줌·i18n=FE lane). **인간 결정이 필요한
 * pending gate에만** action을 낸다(requires_human=false=자동 게이트는 인간 액션 없음·no-fiction).
 * gate_type으로 라벨 분기(merge=병합 검토·loop_decision=방향 결정·그 외=검토 승인). href=게이트 결재
 * 표면(GateInbox — attention gate_pending과 동일 canonical 승인 경로).
 */
export function synthesizeGateAction(
  gate: HeroGateEnvelope | null,
  labels: HeroActionLabels,
): { action: string; href: string } | null {
  if (!gate || !gate.requires_human) return null;
  const action =
    gate.gate_type === 'merge' ? labels.merge :
    gate.gate_type === 'loop_decision' ? labels.decide :
    labels.review;
  return { action, href: '/inbox?tab=gates' };
}
