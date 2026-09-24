import { fetchWithAuth } from '@/lib/db/client';
import { getRequestContextKey } from '@/lib/project-context-client';

/**
 * story #4263 AC1 — `/api/conversations/unread-count`의 공용 요청. 이 수를 쓰는 훅(`useChatUnreadTotal`)이 한 화면에 여럿 마운트된다
 * (dashboard-shell.tsx:191 · today-v3-screen.tsx:81 · chat-v3-screen · connect-rules-v3-screen) — 각자 창 포커스 · 재연결마다 따로 묻어 같은
 * 순간 2번이 나갔다(민 하네스 배포 25 · focus@Window 2). 진행 중인 요청이 있으면 그 약속을 같이 쓴다(designated-pending-count-client와 같은 합류 ·
 * 맥락 키가 바뀌면 새로 묻는다). 실패는 null — 다음 트리거에서 재시도.
 */
let inFlight: { key: string; promise: Promise<number | null> } | null = null;

/** 테스트 전용 — 모듈 상태 초기화. */
export function resetChatUnreadTotalStateForTest(): void {
  inFlight = null;
}

export function fetchChatUnreadTotal(): Promise<number | null> {
  const key = getRequestContextKey();
  if (!inFlight || inFlight.key !== key) {
    const promise = fetchWithAuth('/api/conversations/unread-count')
      .then(async (res) => {
        if (!res.ok) return null;
        const json = (await res.json()) as { count?: number };
        return typeof json.count === 'number' ? json.count : 0;
      })
      .catch(() => null);
    const current = { key, promise };
    inFlight = current;
    void promise.then(() => { if (inFlight === current) inFlight = null; });
  }
  return inFlight.promise;
}
