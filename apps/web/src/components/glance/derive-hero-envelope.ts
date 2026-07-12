/**
 * E-GLANCE 2D hero ProofCapsule 리치 렌더(story 04da0281) — BE `GET /api/v2/glance/hero?story_id=`
 * (#2099·d02082e1) envelope 소비. 계약 SSOT = doc `glance-hero-proofcapsule-be-contract`.
 *
 * ⚠️ **AC1 shape-safety**: attention(#2100)과 동형 — BE는 `HeroResponse` 객체를 주고 FE 프록시가
 * `apiSuccess`로 감싸 실 payload는 `{data:{…}}`가 된다. 방어적 unwrap하고, 형상 불일치(비객체·
 * 핵심 필드 누락·타입 붕괴)는 crash가 아니라 `null` 반환 → 상위(glance-hero)가 리치 필드 없이
 * 정직 최소 렌더로 폴백(no-fiction). BE는 구조화 필드만 주므로 action 라벨은 FE가 합성(i18n=FE lane).
 */

export interface HeroGateEnvelope {
  status: string;
  gate_type: string;
  requires_human: boolean;
  decision_basis: string | null;
  auto_decision_reason: string | null;
}

export interface HeroTrustMember {
  member_id: string;
  name: string;
  role: string | null;
}

export interface HeroTrustEnvelope {
  self_reported: boolean;
  human_verified: boolean;
  human_verified_by: HeroTrustMember | null;
  human_verified_at: string | null;
}

export interface HeroEnvelope {
  story_id: string;
  claim: string;
  status: string;
  proof_count: number;
  auto_verify: 'passed' | 'failed' | null;
  gate: HeroGateEnvelope | null;
  trust: HeroTrustEnvelope;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function unwrapEnvelope(json: unknown): unknown {
  if (!isRecord(json)) return json;
  const d = json['data'];
  return d ?? json;
}

function str(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

function parseGate(raw: unknown): HeroGateEnvelope | null {
  if (!isRecord(raw)) return null;
  const status = str(raw['status']);
  const gateType = str(raw['gate_type']);
  if (!status || !gateType) return null; // 구조 붕괴 게이트는 생략(no-fiction)
  return {
    status,
    gate_type: gateType,
    requires_human: raw['requires_human'] === true,
    decision_basis: str(raw['decision_basis']),
    auto_decision_reason: str(raw['auto_decision_reason']),
  };
}

function parseMember(raw: unknown): HeroTrustMember | null {
  if (!isRecord(raw)) return null;
  const memberId = str(raw['member_id']);
  const name = str(raw['name']);
  if (!memberId || name == null) return null;
  return { member_id: memberId, name, role: str(raw['role']) };
}

function parseTrust(raw: unknown): HeroTrustEnvelope {
  if (!isRecord(raw)) {
    return { self_reported: false, human_verified: false, human_verified_by: null, human_verified_at: null };
  }
  return {
    self_reported: raw['self_reported'] === true,
    human_verified: raw['human_verified'] === true,
    human_verified_by: parseMember(raw['human_verified_by']),
    human_verified_at: str(raw['human_verified_at']),
  };
}

/**
 * 실 payload → 검증된 hero envelope. 핵심 필드(claim·status) 없거나 형상 붕괴면 `null`(리치 렌더
 * 포기·최소 폴백). auto_verify는 알려진 값만 통과(그 외 null), proof_count는 유한 정수만.
 */
export function parseHeroEnvelope(json: unknown): HeroEnvelope | null {
  const inner = unwrapEnvelope(json);
  if (!isRecord(inner)) return null;

  const claim = str(inner['claim']);
  const status = str(inner['status']);
  if (!claim || !status) return null; // 핵심 필드 없으면 리치 소스로 못 씀

  const rawCount = inner['proof_count'];
  const proof_count = typeof rawCount === 'number' && Number.isFinite(rawCount) ? Math.trunc(rawCount) : 0;
  const av = inner['auto_verify'];
  const auto_verify = av === 'passed' || av === 'failed' ? av : null;

  return {
    story_id: str(inner['story_id']) ?? '',
    claim,
    status,
    proof_count,
    auto_verify,
    gate: parseGate(inner['gate']),
    trust: parseTrust(inner['trust']),
  };
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
