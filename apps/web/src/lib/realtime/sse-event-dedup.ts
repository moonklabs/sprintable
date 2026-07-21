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

/**
 * story #2101 — 이미 본 event_id면 true(호출부는 조기 return으로 처리를 건너뛴다).
 *
 * ⚠️ 의도적으로 ref를 감싸는 HOC가 아니라 "핸들러 본문 안에서 호출하는 평범한 함수"로
 * 설계했다 — `withXxx(someRef, handler)` 형태로 ref를 함수 경계 너머로 넘기면
 * react-hooks/refs lint(ref가 렌더 중 읽힐 수 있다고 보수적으로 판단)에 걸린다. 이 함수는
 * 각 handler의 본문 안에서 `shouldSuppressDuplicateSseEvent(xRef.current, raw)`로 호출하는
 * 관례로 쓴다 — handler 본문은 렌더 시점이 아니라 이벤트 도착 시점에만 실행되므로 lint에
 * 안전한, 이 파일의 다른 `xxxRef.current?.(...)` 호출들과 동일한 패턴이다.
 */
export function shouldSuppressDuplicateSseEvent(tracker: SseSeenIdTracker, raw: string): boolean {
  const eventId = extractSseEventId(raw);
  if (eventId === null) return false;
  if (tracker.hasSeen(eventId)) return true;
  tracker.markSeen(eventId);
  return false;
}
