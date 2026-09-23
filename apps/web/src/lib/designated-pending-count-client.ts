import { fetchWithAuth } from '@/lib/db/client';

/**
 * story #4171(E-MOBILE-SPEED) — `GET /api/gates/designated-pending-count` 진행 중 요청 공유.
 * 모바일 첫 화면에서 사이드바(닫힌 시트라도 hook은 돈다)와 하단 탭바가 마운트 때 각자 불러 같은
 * 요청이 2번 나갔다. 동시에 부른 호출은 요청 하나를 나눠 쓰고, 응답이 오면 공유를 끝낸다(저장하는
 * 값 없음 — 폴링·포커스·SSE 재조회는 매번 새로 묻는다). 실패·예외는 null.
 */
let inFlight: Promise<number | null> | null = null;

export function fetchDesignatedPendingCount(): Promise<number | null> {
  if (!inFlight) {
    const current = fetchWithAuth('/api/gates/designated-pending-count')
      .then(async (res) => {
        if (!res.ok) return null;
        const json = await res.json() as { count?: number };
        return typeof json.count === 'number' ? json.count : 0;
      })
      .catch(() => null);
    inFlight = current;
    void current.then(() => { if (inFlight === current) inFlight = null; });
  }
  return inFlight;
}
