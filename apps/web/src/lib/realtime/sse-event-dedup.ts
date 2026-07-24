/**
 * story #2101 — SSE payload `event_id` 기반 중복 억제.
 *
 * 배경: 백엔드 백필이 pending뿐 아니라 최근 delivered 이벤트도 재전달한다(같은 member의
 * 다른 연결(탭)이 이미 받아 delivered로 마킹한 이벤트를, 재연결한 이 연결도 다시 받게
 * 해서 영구 유실을 막는다 — 서버는 "최소 한 번" 배달만 보장). 클라이언트가 event_id로
 * 걸러야 "정확히 한 번"으로 좁혀진다 — 안 거르면 뱃지가 부풀고 알림이 중복되는
 * (story #2090과 동일 클래스의 phantom 부작용).
 *
 * event_id가 없는 페이로드(레거시/하위호환 이벤트)는 dedup 없이 통과 — 과거 동작 무회귀.
 *
 * ⚠️ 설계 이력(오르테가군 지적, 2026-07-22) — HOC 형태를 두 번 시도했고 둘 다 이
 * 코드베이스의 react-hooks/refs lint에 막혔다. **`withSseEventIdDedup(handler)`류
 * 래퍼는 이 파일에 없다 — 의도적으로 뺐다:**
 *   1차: `withXxx(someRef, handler)` — ref를 함수 경계 너머로 넘기는 것 자체가 막힘.
 *   2차: tracker를 모듈 스코프 싱글턴으로 옮겨 ref 인자를 없앤 순수 HOC
 *        `withXxx(handler)` — 그래도 막혔다. 이 lint 규칙은 "ref를 넘기는 것"이 아니라
 *        **"ref를 내부에서 읽는 클로저를 다른 함수 호출의 인자로 넘기는 것" 자체**를
 *        보수적으로 금지한다 — 그 함수가 인자를 렌더 중에 동기 호출할지 lint가 정적으로
 *        증명할 수 없기 때문. use-chat-sse.ts/use-sse-notifications.ts의 모든 handler는
 *        "최신 콜백 prop을 담아두는 ref"(`onXxxRef.current`, stale-closure 방지 관례)를
 *        내부에서 읽으므로 이 규칙에 걸린다 — 이 파일의 dedup 로직과 무관하게, **이
 *        코드베이스에서 handler를 HOC로 감싸는 패턴 자체가 구조적으로 막혀 있다.**
 *
 * ⇒ 그래서 `shouldSuppressDuplicateSseEvent(raw)`를 각 handler 본문 **첫 줄**에서 직접
 * 호출하는 관례로 간다. 이건 "구조로 막는다"가 아니라 "관례를 지킨다"에 더
 * 가깝다 — 새 SSE handler를 추가하면서 이 첫 줄을 빠뜨려도 에러 없이 조용히 새는다(story
 * #2090류와 같은 성격의 리스크).
 *
 * ⚠️ 2026-07-24 정정(story #2102 ②) — 이 자리에 예전엔 "현재 7곳"이라 적혀 있었으나 전수
 * grep으로 확認한 실제 호출부는 **2개 파일 5곳**(use-chat-sse.ts 3곳·use-sse-notifications.ts
 * 2곳)뿐이었다 — "7"의 근거가 무엇이었는지 추적 불가, 그냥 stale한 숫자였던 것으로 보인다.
 * 이제 이 숫자를 주석에 다시 안 적는다 — `sse-dedup-enforcement.test.ts`의 실 소스트리
 * 게이트가 매번 최신 상태를 검사하므로, 여기 하드코딩된 카운트는 곧 또 stale해질 뿐이다.
 * 관례를 "지키고 있다고 주석이 말하는데 실제로 안 지켜지는" 바로 그 위험이 이미 여기서
 * 벌어지고 있었다 — 정적 스캔 게이트(`findUndeclaredSseHandlers`)로 대체한다.
 *
 * ⚠️ **새 SSE handler를 만들 때는 이 함수를 반드시 첫 줄에서 호출할 것.** 빠뜨리면
 * `sse-dedup-enforcement.test.ts`의 실 소스트리 게이트가 잡는다(story #2102 ② — 정적 스캔,
 * dedup 호출도 exempt 등록도 없는 새 named-event 소비 파일이면 실패) — 다만 그 게이트는
 * 파일 단위 판정이라 완벽하지 않다(sse-dedup-enforcement.ts 상단 주석의 한계 선언 참고).
 * 게이트 이전에는 컴파일도 테스트도 안 걸리고 unread 뱃지가 조용히 이중 증가하거나 알림
 * 리스트에 중복이 쌓이는 형태로만 드러났다(원인 파악이 어려운 클래스의 버그였다).
 */

const _MAX_SEEN_IDS = 500; // 무한 증식 방지 — FIFO 경계(재연결 시나리오엔 넉넉한 여유)

export interface SseSeenIdTracker {
  hasSeen(id: string): boolean;
  markSeen(id: string): void;
}

export function createSeenIdTracker(): SseSeenIdTracker {
  const seen = new Set<string>();
  const order: string[] = [];
  return {
    hasSeen(id: string): boolean {
      return seen.has(id);
    },
    markSeen(id: string): void {
      if (seen.has(id)) return;
      seen.add(id);
      order.push(id);
      if (order.length > _MAX_SEEN_IDS) {
        const oldest = order.shift();
        if (oldest !== undefined) seen.delete(oldest);
      }
    },
  };
}

/** raw SSE payload 문자열에서 event_id를 안전하게 추출(파싱 실패·필드 부재 시 null). */
export function extractSseEventId(raw: string): string | null {
  try {
    const parsed = JSON.parse(raw) as { event_id?: unknown };
    return typeof parsed.event_id === 'string' ? parsed.event_id : null;
  } catch {
    return null;
  }
}

/** 앱 전역 SSE 이벤트가 공유하는 단일 seen-id 저장소 — 모듈 스코프(React ref 아님). */
const _globalSeenIds = createSeenIdTracker();

/**
 * 이미 본 event_id면 true(호출부는 조기 return으로 처리를 건너뛴다) — 전역 싱글턴 기준.
 * 각 SSE handler 본문 **첫 줄**에서 직접 호출하는 것이 관례다(위 설계 이력 참고 — HOC로
 * 감쌀 수 없다).
 */
export function shouldSuppressDuplicateSseEvent(raw: string): boolean {
  const eventId = extractSseEventId(raw);
  if (eventId === null) return false;
  if (_globalSeenIds.hasSeen(eventId)) return true;
  _globalSeenIds.markSeen(eventId);
  return false;
}
