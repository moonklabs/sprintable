/**
 * story #4320 — BFF(Next 라우트 · 서버 헬퍼) → FastAPI 백엔드 `fetch`의 취소 · 시간 제한 한 곳.
 *
 * 예전엔 BFF의 백엔드 fetch에 `signal`이 없었다. 브라우저는 4310으로 30초에 요청을 끊지만 그 취소가 BFF → 백엔드로 전해지지 않아,
 * 백엔드가 멈추면 BFF 요청이 백엔드가 답할 때까지(또는 Cloud Run 요청 한도까지) 붙잡혔다.
 *
 * `backendSignal(request, timeoutMs)`은 두 신호를 합친다:
 *   - 원 요청의 `request.signal` — 브라우저가 끊으면(탭 닫기 · 4310 시간 초과 · 이동) 백엔드 호출도 끊긴다.
 *   - `timeoutMs`(기본 30초 · 4310 `FETCH_WITH_AUTH_DEFAULT_TIMEOUT_MS`와 같은 수) — 원 요청이 살아 있어도 백엔드가 이만큼 답하지 않으면 끊는다.
 * 요청 스코프가 없는 서버 헬퍼(서버 컴포넌트에서 부르는 조회 등)는 `request`에 null을 넘겨 시간 제한만 건다.
 *
 * 시간 초과는 `DOMException` name `TimeoutError`, 원 요청 취소는 `AbortError`로 던져진다 — `classifyBackendAbort`로 가른다.
 */
/** 기본 백엔드 시간 제한 — 브라우저 쪽(4310 `FETCH_WITH_AUTH_DEFAULT_TIMEOUT_MS`)과 같은 수. 그 모듈은 'use client'라 서버에서 가져오지
 * 않고 값을 적어 두며, 같은 수인지는 테스트가 고정한다. 더 오래 걸리는 변환 계열은 호출부가 길게 넘긴다. */
export const BFF_BACKEND_TIMEOUT_MS = 30_000;

/** OAuth 콜백처럼 **브라우저 쪽 제한이 없는 이동**(페이지 이동 · 4310 fetchWithAuth 밖)인데 백엔드가 외부 API를 잇달아 부르는 계열 —
 * 채널 콜백은 외부 호출 최대 3번 × 호출당 15초(channel_connections.py httpx timeout=15), 로그인 콜백은 코드 교환 + 사용자 정보(auth.py
 * timeout=15). 코드에서 뽑은 최악값(45초)에 여유 — 실측 분포 아님. */
export const BFF_BACKEND_EXTERNAL_CHAIN_TIMEOUT_MS = 60_000;

/** 문서 · 첨부 변환처럼 백엔드가 오래 걸리는 계열 — 브라우저 쪽 file-viewer 변환 호출(130초)과 같은 수. */
export const BFF_BACKEND_CONVERT_TIMEOUT_MS = 130_000;

export function backendSignal(request: Request | null | undefined, timeoutMs: number = BFF_BACKEND_TIMEOUT_MS): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return request?.signal ? AbortSignal.any([request.signal, timeout]) : timeout;
}

/** fetch가 던진 오류를 가른다: 시간 초과 · 원 요청 취소 · 그 밖(연결 실패 등). */
export function classifyBackendAbort(err: unknown): 'timeout' | 'client-abort' | 'other' {
  const name = (err as { name?: unknown } | null)?.name;
  if (name === 'TimeoutError') return 'timeout';
  if (name === 'AbortError') return 'client-abort';
  return 'other';
}
