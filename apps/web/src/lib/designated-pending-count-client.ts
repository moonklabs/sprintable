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
let inFlight: { key: string; promise: Promise<number | null> } | null = null;

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
  lastWatermark = null;
}

export function fetchDesignatedPendingCount(): Promise<number | null> {
  const key = getRequestContextKey();
  if (!inFlight || inFlight.key !== key) {
    const promise = fetchWithAuth('/api/gates/designated-pending-count')
      .then(async (res) => {
        if (!res.ok) return null;
        const json = await res.json() as { count?: number; snapshot_xmin?: string | null };
        const xmin = parseXid(json.snapshot_xmin);
        if (xmin !== null) lastWatermark = { key, xmin };
        return typeof json.count === 'number' ? json.count : 0;
      })
      .catch(() => null);
    const current = { key, promise };
    inFlight = current;
    void promise.then(() => { if (inFlight === current) inFlight = null; });
  }
  return inFlight.promise;
}
