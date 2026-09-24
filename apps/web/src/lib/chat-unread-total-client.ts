import { fetchWithAuth } from '@/lib/db/client';
import { getRequestContextKey } from '@/lib/project-context-client';

/**
 * story #4263 AC1 — `/api/conversations/unread-count`의 공용 요청. 이 수를 쓰는 훅(`useChatUnreadTotal`)이 한 화면에 여럿 마운트된다
 * (dashboard-shell.tsx:191 · today-v3-screen.tsx:81 · chat-v3-screen · connect-rules-v3-screen) — 각자 창 포커스 · 재연결마다 따로 묻어 같은
 * 순간 2번이 나갔다(민 하네스 배포 25 · focus@Window 2). 진행 중인 요청이 있으면 그 약속을 같이 쓴다(designated-pending-count-client와 같은 합류 ·
 * 맥락 키가 바뀌면 새로 묻는다). 실패는 null — 다음 트리거에서 재시도.
 */
let inFlight: { key: string; seq: number; turn: object | null; promise: Promise<number | null> } | null = null;
let freshTurn: object | null = null;
// story #4263(PO 14:57Z ①) — 이벤트(conversation.read · 재연결)가 부른 재조회는 앞선 요청에 합류하지 않고 새로 묻는다 — 합류하면 이벤트 전
// 스냅숏을 받아 다음 계기까지 낡은 수가 남는다. 더 새 요청이 뜬 뒤 끝난 옛 응답은 그 새 요청의 값으로 풀린다(마지막 요청 값만 반영).
let requestSeq = 0;
let latest: { key: string; seq: number; turn: object | null; promise: Promise<number | null> } | null = null;

/** 테스트 전용 — 모듈 상태 초기화. */
export function resetChatUnreadTotalStateForTest(): void {
  inFlight = null;
  latest = null;
}

/** @param opts.fresh 이벤트가 부른 재조회면 true — 진행 중 요청에 합류하지 않는다. 기동 · 포커스처럼 같은 계기끼리는 합류(기본). */
export function fetchChatUnreadTotal(opts?: { fresh?: boolean }): Promise<number | null> {
  const key = getRequestContextKey();
  if (!opts?.fresh && inFlight && inFlight.key === key) return inFlight.promise;
  // 같은 이벤트의 구독자 여럿(사이드바 · 탭바 · 훅 여러 마운트)은 한 동기 디스패치 안에서 잇달아 부른다 — 그 안의 fresh 호출끼리는 합류한다
  // (이벤트당 요청 1). 디스패치가 끝나면(마이크로태스크) 다음 fresh는 새로 묻는다.
  if (opts?.fresh && inFlight && inFlight.key === key && inFlight.turn !== null && inFlight.turn === freshTurn) return inFlight.promise;
  let turn: object | null = null;
  if (opts?.fresh) {
    if (freshTurn === null) { freshTurn = {}; queueMicrotask(() => { freshTurn = null; }); }
    turn = freshTurn;
  }
  const seq = ++requestSeq;
  const raw = fetchWithAuth('/api/conversations/unread-count')
    .then(async (res) => {
      if (!res.ok) return null;
      const json = (await res.json()) as { count?: number };
      return typeof json.count === 'number' ? json.count : 0;
    })
    .catch(() => null);
  const promise: Promise<number | null> = raw.then((value) => {
    const newer = latest;
    return newer && newer.key === key && newer.seq > seq ? newer.promise : value;
  });
  const current = { key, seq, turn, promise };
  inFlight = current;
  latest = current;
  void raw.then(() => { if (inFlight === current) inFlight = null; });
  return promise;
}
