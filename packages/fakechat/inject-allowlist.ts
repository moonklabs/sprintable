/**
 * E-CHAT-CMD S9: fakechat 이벤트 주입 허용 event-type allowlist.
 *
 * SDK `connectors/sdk/sprintable_sse.py` 의 `INJECTABLE_EVENT_TYPES` 와 **동일한** 목록.
 * 이 목록 밖의 event_type 은 content 가 실려 있어도 work-turn 으로 주입하지 않고 드롭한다
 * (FYI poisoning 방지: status_changed/task_completed/agent_joined/sprint_closed/file_conflict 등).
 *
 * ⚠️ 언어 경계(Python ↔ TS)라 상수를 import 할 수 없다 — 값 변경 시 `sprintable_sse.py` 와
 * **반드시 함께** 동기화할 것. (S9 이전에는 fakechat 만 이 게이트가 누락된 유일 갭이었다.)
 */
export const INJECTABLE_EVENT_TYPES: ReadonlySet<string> = new Set<string>([
  'dispatched',
  'story_assigned',
  'conversation.message_created',
  'conversation:mention',
  'kickoff',
  'review_request',
  'qa_request',
  'deploy_request',
  'handoff',
])

/**
 * event_type 을 data 최상위 → payload fallback 순으로 추출해 allowlist 멤버십을 판정한다.
 * (sprintable_sse.py:156-157 동형 — content 체크 **전**에 호출.)
 * event_type 이 없거나 문자열이 아니거나 allowlist 밖이면 false(=드롭).
 */
export function isInjectableEventType(
  data: Record<string, unknown>,
  payload: Record<string, unknown>,
): boolean {
  const eventType = data.event_type ?? payload.event_type
  return typeof eventType === 'string' && INJECTABLE_EVENT_TYPES.has(eventType)
}
