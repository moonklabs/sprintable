/**
 * story #2102 ② — "새 SSE handler가 dedup을 거치는지"를 관례가 아니라 검사로 강제한다.
 *
 * `sse-event-dedup.ts` 상단 주석이 이미 실증해둔 대로, 이 코드베이스에서 handler를 HOC로
 * 감싸 구조적으로 강제하는 것은 불가능하다(react-hooks/refs lint가 "ref를 내부에서 읽는
 * 클로저를 다른 함수 호출의 인자로 넘기는 것" 자체를 막음 — 2회 시도, 2회 모두 막힘). 그래서
 * 여기서는 **정적 소스 스캔**으로 대신한다: named SSE 이벤트를 구독하는 것으로 보이는 파일이
 * `shouldSuppressDuplicateSseEvent`를 호출하지 않으면서 EXEMPT 등록도 없으면 잡는다.
 *
 * ⚠️ 못 잡는 것(선언, story #2102 AC1/AC5) — 이건 정규식 휴리스틱이지 AST 분석이 아니다:
 *   ① dedup 함수를 다른 이름으로 재-export/re-alias해서 호출하면 못 알아본다.
 *   ② 이벤트명을 문자열 리터럴이 아니라 변수로 동적 구성해 `.addEventListener(name, ...)`/
 *      `mux.subscribe(name, ...)`를 호출하면 SSE_CONSUMER_PATTERN이 못 잡을 수 있다(현재는
 *      실제 호출부 전부가 문자열 리터럴이라 오탐/누락 없음 — grep으로 확認).
 *   ③ 파일 단위 판정이지 함수 단위가 아니다 — 한 파일 안에 dedup을 호출하는 handler와 안
 *      호출하는 handler가 섞여 있으면, 파일에 dedup 호출이 하나라도 있으면 그 파일 전체가
 *      "통과"로 잡혀 안 부르는 다른 handler는 못 걸러낸다.
 */

export interface SourceFile {
  path: string;
  content: string;
}

/** named SSE 이벤트 구독으로 보이는 패턴 — 실제 호출부(mux.subscribe 계열)와 EventSource
 * 폴백 경로(addEventListener) 전부를 커버하되, `document.addEventListener('keydown', ...)`류
 * 일반 DOM 이벤트는 걸지 않는다: SSE named 이벤트는 전부 `entity.action` 점 표기(예:
 * story.status_changed·conversation.working) 또는 아래 알려진 bare 이름(presence 등)이고,
 * 일반 DOM 이벤트명(keydown·click·resize·scroll·focus·change·visibilitychange 등)은 점을
 * 포함하지 않는다 — 실 소스트리 대조로 오탐 0 확認(sse-dedup-enforcement.test.ts). */
const KNOWN_BARE_SSE_EVENT_NAMES = ['presence', 'notification', 'event_notification', 'new_notification'];
const SSE_CONSUMER_PATTERN = new RegExp(
  `\\bmux\\.subscribe\\(|\\.addEventListener\\(\\s*['"]([\\w-]+\\.[\\w-]+|${KNOWN_BARE_SSE_EVENT_NAMES.join('|')})['"]`,
);

const DEDUP_CALL_PATTERN = /shouldSuppressDuplicateSseEvent\s*\(/;

export function isLikelySseConsumer(content: string): boolean {
  return SSE_CONSUMER_PATTERN.test(content);
}

export function callsDedup(content: string): boolean {
  return DEDUP_CALL_PATTERN.test(content);
}

/**
 * exemptions: 파일 경로(SourceFile.path와 정확히 일치) → dedup을 안 태워도 되는 이유.
 * 이유가 빈 문자열/공백뿐이면 exempt로 인정하지 않는다(근거 없는 면제 방지).
 */
export function findUndeclaredSseHandlers(
  files: SourceFile[],
  exemptions: Record<string, string>,
): string[] {
  const flagged: string[] = [];
  for (const file of files) {
    if (!isLikelySseConsumer(file.content)) continue;
    if (callsDedup(file.content)) continue;
    const reason = exemptions[file.path];
    if (reason && reason.trim().length > 0) continue;
    flagged.push(file.path);
  }
  return flagged;
}
