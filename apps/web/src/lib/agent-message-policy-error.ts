// story #2613(PR #2824 승계, story #4181 CHANGES — 실 응답 모양 교정) — BE(PR #3096,
// backend/app/routers/conversations.py)가 대화 생성/참여자 추가를 에이전트 creator/allowlist
// 정책으로 거부할 때 `HTTPException(status_code=403, detail={code, message, details})`를
// raise하고, main.py의 전역 `http_exception_handler`가 dict detail을 최종 응답 봉투로
// 펼친다 — 실제로 FE가 받는 모양은:
//   { data: null, error: { code: 'AGENT_MESSAGE_POLICY_DENIED', message: <영문 고정문>,
//                           details: { agent_id, member_id?, reason } }, meta: null }
// (story #4181: 이전 구현은 `body.detail.*`을 읽어 항상 null로 떨어졌다 — main.py가
// dict detail을 `error` 키로 승격한다는 계약을 반영 못 한 결함, 픽스처끼리만 맞아서
// 로컬 테스트로는 안 잡혔다.) `error.message`는 로케일 무관 영문 고정 문구라 그대로
// 노출하지 않는다(기존 invalid_payload 계약과 동형 원칙, PR#3096 본문 명시) — FE가
// reason을 보고 자체 i18n으로 재구성한다.
export type AgentMessagePolicyDeniedReason = 'allowlist_miss' | 'created_by_none' | 'creator_not_participant';

export interface AgentMessagePolicyDeniedDetails {
  agent_id: string;
  member_id?: string;
  reason: AgentMessagePolicyDeniedReason;
}

const KNOWN_REASONS = new Set<string>(['allowlist_miss', 'created_by_none', 'creator_not_participant']);

export function parseAgentMessagePolicyDenied(body: unknown): AgentMessagePolicyDeniedDetails | null {
  if (!body || typeof body !== 'object') return null;
  const error = (body as { error?: unknown }).error;
  if (!error || typeof error !== 'object') return null;
  const e = error as { code?: unknown; details?: unknown };
  if (e.code !== 'AGENT_MESSAGE_POLICY_DENIED') return null;
  if (!e.details || typeof e.details !== 'object') return null;
  const details = e.details as { agent_id?: unknown; member_id?: unknown; reason?: unknown };
  if (typeof details.agent_id !== 'string' || typeof details.reason !== 'string' || !KNOWN_REASONS.has(details.reason)) return null;
  return {
    agent_id: details.agent_id,
    member_id: typeof details.member_id === 'string' ? details.member_id : undefined,
    reason: details.reason as AgentMessagePolicyDeniedReason,
  };
}

// new-conversation-modal.tsx·add-participant-modal.tsx 공유 — 「대상 에이전트·멤버」를 사람
// 이름으로 되돌리는 로직이 두 곳에서 동일해(AC2), 여기 하나로 둔다. member 조회 대상은
// 두 모달이 이미 들고 있는 project 멤버 목록(agent도 포함된 동일 리스트)이라 그대로 받는다.
export function buildPolicyDeniedMessage(
  policy: AgentMessagePolicyDeniedDetails,
  members: { id: string; name: string }[],
  t: (key: string, values?: Record<string, string>) => string,
): string {
  const agentName = members.find((m) => m.id === policy.agent_id)?.name ?? t('policyDeniedUnknownAgent');
  if (policy.reason === 'allowlist_miss') {
    const memberName = (policy.member_id && members.find((m) => m.id === policy.member_id)?.name) ?? t('policyDeniedUnknownMember');
    return t('policyDeniedAllowlistMiss', { member: memberName, agent: agentName });
  }
  if (policy.reason === 'created_by_none') return t('policyDeniedCreatedByNone', { agent: agentName });
  return t('policyDeniedCreatorNotParticipant', { agent: agentName });
}
