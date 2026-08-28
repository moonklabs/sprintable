/**
 * story #2162 — 재개 커서(`last_event_id`) 오염 방지.
 *
 * `presence`·`conversation.working`처럼 DB `Event` 행이 없는 transient push(서버가 `uuid4()`를
 * SSE 프레임 native id로 붙여 내보내는 것 — dedup이 보는 payload의 `event_id` 필드와는 별개
 * 개념, 그건 sse-event-dedup.ts)는 재연결 시 `last_event_id`로 그대로 실려나가도 서버가 그
 * id를 `Event` 행으로 못 풀어 시간 기준점이 None이 된다. 그런데 "값은 있으니 초기연결이
 * 아니다"로 판정돼 INITIAL 상한도 안 걸리는 채로 시간 필터 자체가 안 붙어 최근 50건이
 * 통째로 재전송된다(#2162 근본 — B계열은 원래도 이랬으나 #2158로 재생 대상이 되며 실제
 * 하중을 받기 시작함).
 *
 * ⇒ 마지막 수신 이벤트가 B계열이면 그 프레임의 native id(`e.lastEventId`)를 커서로 승격하지
 * 않는다 — B계열이 오기 전 마지막으로 승격된(A계열) id가 그대로 유지되어, 다음 재연결도
 * 해소 가능한 커서로 나간다.
 *
 * ⚠️ 알려진 B계열만 명시한다(추측 금지 — story #2162 조사에서 실제로 확認된 두 이름 + story
 * #3180이 추가한 세 번째뿐이다).
 * 새로운 transient(DB-row 없는) named 이벤트를 추가할 땐 **반드시 여기에도 추가할 것** —
 * 안 그러면 목록에 없는 이름은 전부 "커서 승격 가능"으로 취급돼 이 버그가 조용히 재발한다.
 *
 * story #3180 — `attention.changed`(backend/app/services/attention_events.py::
 * notify_attention_changed → push_to_org_members(..., {})) 도 presence와 동일 모양의 B계열
 * (Event DB row 0, payload 없음)이라 여기 편입한다.
 */
const TRANSIENT_EVENT_NAMES = new Set(['presence', 'conversation.working', 'attention.changed']);

/**
 * true면 이 이벤트의 네이티브 SSE id를 재개 커서로 승격해도 안전(DB로 해소 가능하다고 알려짐
 * 또는 미분류). false면 승격 금지(알려진 B계열).
 *
 * eventName이 없는 경우(이름 없는 기본 `message` 채널)는 과거 동작 그대로 승격 허용 —
 * 지금까지 그 경로에서 문제가 보고된 적이 없어 무회귀를 우선한다.
 */
export function isCursorEligibleEventName(eventName: string | undefined): boolean {
  if (!eventName) return true;
  return !TRANSIENT_EVENT_NAMES.has(eventName);
}
