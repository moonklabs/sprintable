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
 *
 * ⚠️ 2026-07-25 정정(story #2163) — seen-id 저장소가 모듈 스코프 **전역 싱글턴**이었던 것이
 * 새로운 버그 클래스를 낳았다: "이 이벤트를 내가 이미 처리했나"는 **소비자별** 질문인데,
 * 그 답을 탭 전체가 공유하는 Set 하나가 대신하고 있었다. 같은 탭 안에 `useChatSse`를 각자
 * 부르는 서로 다른 컨슈머(ChatView 자신 · GNB unread 뱃지의 `useChatUnreadTotal`)가 동시에
 * 마운트돼 있으면, 같은 `event_id`가 둘 다에 도착했을 때 **먼저 처리한 쪽이 "이미 봤다"로
 * 마킹**해 버려 **나중 컨슈머는 자기 입장에서는 처음 보는 이벤트인데도 조용히 굶는다** —
 * 뱃지는 +1 되는데 채팅창은 안 바뀌는 증상(정신병 리스트 #2163)이 이것이었다.
 * ⇒ seen-id 저장소를 **호출부(각 `useChatSse`/`useSseNotifications` 인스턴스)가 직접
 * 만들어 들고 있다가 이 함수에 넘기는 방식**으로 바꿨다 — 인스턴스가 언마운트되면 그
 * Set도 같이 사라진다(전역 수명 잔존 없음). #2101의 원 목적(같은 컨슈머가 재연결 백필로
 * 같은 이벤트를 두 번 받는 것 억제)은 **그 컨슈머 자신의 tracker 안에서 그대로 유지**된다
 * — 애초에 그 중복도 "같은 컨슈머가 같은 걸 두 번" 문제였으므로 인스턴스 스코프로 충분하다.
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
 * 이미 본 event_id면 true(호출부는 조기 return으로 처리를 건너뛴다) — `tracker` 기준(story
 * #2163 — 전역 싱글턴 아님, 호출부가 자기 인스턴스 수명에 맞는 tracker를 직접 들고 있다가
 * 넘긴다). 각 SSE handler 본문 **첫 줄**에서 직접 호출하는 것이 관례다(위 설계 이력 참고 —
 * HOC로 감쌀 수 없다).
 */
export function shouldSuppressDuplicateSseEvent(raw: string, tracker: SseSeenIdTracker): boolean {
  const eventId = extractSseEventId(raw);
  if (eventId === null) return false;
  if (tracker.hasSeen(eventId)) return true;
  tracker.markSeen(eventId);
  return false;
}
