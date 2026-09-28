import { fetchWithAuth } from '@/lib/db/client';
import { getRequestContextKey } from '@/lib/project-context-client';
import { isBackfillEvent } from '@/lib/realtime/sse-multiplexer';

/**
 * story #4171(E-MOBILE-SPEED) — `GET /api/gates/designated-pending-count` 진행 중 요청 공유.
 * 모바일 첫 화면에서 사이드바(닫힌 시트라도 hook은 돈다)와 하단 탭바가 마운트 때 각자 불러 같은
 * 요청이 2번 나갔다. 동시에 부른 호출은 요청 하나를 나눠 쓰고, 응답이 오면 공유를 끝낸다(저장하는
 * 값 없음 — 폴링·포커스·SSE 재조회는 매번 새로 묻는다). 실패·예외는 null.
 * 합류는 요청 맥락(인터셉터가 싣는 org·project)이 같을 때만 — org 전환 직전에 출발한 요청에 전환 뒤
 * 호출이 붙어 이전 org의 수를 받지 않게(lib/me-client.ts와 같은 규칙).
 */
let inFlight: { key: string; seq: number; turn: object | null; promise: Promise<number | null> } | null = null;
let freshTurn: object | null = null;
// story #4263(PO 14:57Z ①) — 요청 순번. 이벤트가 부른 재조회는 앞선 요청에 합류하지 않고 새로 묻는다(합류하면 이벤트 전 스냅숏을 받는다).
// 늦게 도착한 옛 응답이 새 값을 덮지 않게, 더 새 요청이 뜬 뒤 끝난 응답은 그 새 요청의 값으로 풀린다(마지막 요청 값만 반영).
let requestSeq = 0;
let latest: { key: string; seq: number; turn: object | null; promise: Promise<number | null> } | null = null;

// story #4245(까디르 QA P2 · PO 04:12Z) — 마지막으로 받은 수의 스냅숏 워터마크(BE `snapshot_xmin` = pg_snapshot_xmin(pg_current_snapshot())).
// 시각(now() = 트랜잭션 시작)으로는 «수를 센 순간 이미 보였나»를 못 가른다 — 커밋 가시성으로 가른다. 요청 맥락(org·project) 키와 함께 둔다 —
// org 전환 뒤 새 맥락의 수를 받기 전엔 옛 맥락의 워터마크로 판정하지 않는다(모르면 다시 묻는다).
let lastWatermark: { key: string; xmin: bigint } | null = null;

function parseXid(v: unknown): bigint | null {
  if (typeof v !== 'string' || !/^\d+$/.test(v)) return null;
  try { return BigInt(v); } catch { return null; }
}

/**
 * story #4245 — SSE 연결 직후 백필 이벤트가 **마지막 수에 이미 보였던** 것인지. 이벤트를 만든 트랜잭션(created_xid)이 수를 센 순간의 워터마크보다
 * 작으면 그 트랜잭션은 그때 이미 끝났다(커밋이면 수에 보였고 · 롤백이면 이벤트 자체가 없다) → 다시 묻지 않는다.
 * 백필이 아니거나(실시간) · created_xid 없음(옛 행) · 워터마크 모름 · 맥락 다름 · 워터마크 이상(그때 아직 안 끝난 트랜잭션)이면 false — 다시 묻는다.
 */
export function isEventReflectedInLastCount(data: string): boolean {
  if (!isBackfillEvent(data) || lastWatermark === null || lastWatermark.key !== getRequestContextKey()) return false;
  try {
    const createdXid = parseXid((JSON.parse(data) as { created_xid?: unknown }).created_xid);
    return createdXid !== null && createdXid < lastWatermark.xmin;
  } catch {
    return false;
  }
}

/** 테스트 전용 — 모듈 상태 초기화. */
export function resetDesignatedPendingCountStateForTest(): void {
  inFlight = null;
  latest = null;
  lastWatermark = null;
}

/**
 * @param opts.fresh 이벤트(SSE)가 부른 재조회면 true — 진행 중 요청(이벤트 전에 떴을 수 있음)에 합류하지 않고 새로 묻는다. 기동 · 포커스 ·
 *   폴링처럼 같은 계기끼리는 합류한다(기본).
 */
export function fetchDesignatedPendingCount(opts?: { fresh?: boolean }): Promise<number | null> {
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
  // 까디르 codex 4626 P2 — 워터마크는 **가장 최근에 뜬 요청의 응답만** 기록한다. 옛 요청이 늦게 오면 그 수와 워터마크를 모두 버리고,
  // 최신 응답이 실패하거나 유효한 워터마크가 없으면 이전 워터마크를 **무효화**한다 — 판정이 «이미 반영»(백필 건너뜀)이 아니라 «모름 → 다시
  // 묻기»로 떨어지게(옛 워터마크가 남아 뒤 백필 이벤트를 건너뛰면 배지가 폴링까지 낡는다 · 4605 판정을 흐림).
  const isLatest = () => latest !== null && latest.seq === seq;
  const raw = fetchWithAuth('/api/gates/designated-pending-count')
    .then(async (res) => {
      if (!res.ok) { if (isLatest()) lastWatermark = null; return null; }
      const json = await res.json() as { count?: number; snapshot_xmin?: string | null };
      const xmin = parseXid(json.snapshot_xmin);
      if (isLatest()) lastWatermark = xmin !== null ? { key, xmin } : null;
      return typeof json.count === 'number' ? json.count : 0;
    })
    .catch(() => { if (isLatest()) lastWatermark = null; return null; });
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

/** story #4263 — 결재 대기 수를 바꿀 수 있는 게이트 SSE 이벤트(승인 · 반려 · 위임 · 토스). 사이드바와 모바일 탭바가 같은 목록 · 같은 판정을 쓴다. */
export const DESIGNATED_PENDING_COUNT_EVENTS = ['conversation.gate_resolved', 'conversation.gate_delegated', 'conversation.gate_tossed'] as const;

/**
 * story #4263 AC2 — 결재 대기 수의 라이브 갱신 한 곳(예전엔 app-sidebar에만 있었다). 위 이벤트마다 다시 묻되, 연결 직후 백필 중 마지막 수에
 * 이미 보였던 이벤트는 건너뛴다(#4245 워터마크 · isEventReflectedInLastCount). 반환 = 구독 해지.
 */
export function subscribeDesignatedPendingCount(
  mux: { subscribe: (eventName: string, handler: (data: string) => void) => () => void },
  onCount: (count: number) => void,
): () => void {
  const refetch = (data: string) => {
    if (isEventReflectedInLastCount(data)) return;
    // story #4263 ① — 이벤트가 부른 재조회는 이벤트 전에 뜬 요청에 합류하지 않는다(fresh).
    void fetchDesignatedPendingCount({ fresh: true }).then((count) => { if (count !== null) onCount(count); });
  };
  const unsubs = DESIGNATED_PENDING_COUNT_EVENTS.map((name) => mux.subscribe(name, refetch));
  return () => { for (const unsub of unsubs) unsub(); };
}
