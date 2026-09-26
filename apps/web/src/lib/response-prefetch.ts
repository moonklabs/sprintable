/**
 * story #4328 — 화면 데이터 요청 선출발의 공용 규칙(4276 결재 선출발에서 뽑음). 화면이 붙기 전에(로딩 경계 · 부모 화면 마운트) 같은 주소의
 * 요청을 먼저 출발시키고, 화면은 그 응답을 **한 번** 넘겨받는다. 넘겨받기 규칙(오래된 값이 화면에 서지 않게):
 * - 1회용: 넘겨준 항목은 바로 지운다(그 뒤 새로고침 · 폴링 · 더 보기는 늘 새 요청).
 * - 기한: 선출발 시각부터 `ttlMs`가 지나면 버리고 새로 요청한다.
 * - 범위: 항목마다 선출발한 쪽의 범위 키(사람 · 프로젝트 등)를 적고, 넘겨받는 쪽의 현재 범위와 다르면 버린다.
 * - 같은 범위 · 기한 안 항목이 있으면 다시 출발하지 않는다(StrictMode 이중 effect · 여러 선출발 지점).
 * - 실패는 넘기지 않는다(까디르 4694 ②): 선출발이 거부되거나 `!ok`면 버리고 화면이 제 요청을 **한 번** 한다 — 선출발은 없을 때보다
 *   나빠지면 안 된다(화면 열기 직전 일시 실패를 화면이 다시 시도하지 않고 받는 일이 없게). 그 제 요청의 결과는 그대로 넘긴다.
 */
import { fetchWithAuth } from '@/lib/db/client';

export interface ResponsePrefetch {
  start(url: string, scopeKey: string, now?: number): void;
  take(url: string, scopeKey: string, now?: number): Promise<Response>;
  /** 테스트 전용 — 상태 비우기. */
  reset(): void;
}

export function createResponsePrefetch(ttlMs: number): ResponsePrefetch {
  const entries = new Map<string, { startedAt: number; scopeKey: string; response: Promise<Response> }>();
  return {
    start(url, scopeKey, now = Date.now()) {
      const existing = entries.get(url);
      if (existing && existing.scopeKey === scopeKey && now - existing.startedAt <= ttlMs) return;
      const response = fetchWithAuth(url);
      // 아무도 안 넘겨받고 기한이 지나 버려질 수 있다 — 그때 실패가 «처리 안 된 거부»로 새지 않게. 넘겨받는 쪽은 원래 promise로 실패를 받는다.
      response.catch(() => {});
      entries.set(url, { startedAt: now, scopeKey, response });
    },
    take(url, scopeKey, now = Date.now()) {
      const entry = entries.get(url);
      entries.delete(url);
      if (entry && entry.scopeKey === scopeKey && now - entry.startedAt <= ttlMs) {
        return entry.response.then((res) => (res.ok ? res : fetchWithAuth(url)), () => fetchWithAuth(url));
      }
      return fetchWithAuth(url);
    },
    reset() {
      entries.clear();
    },
  };
}
