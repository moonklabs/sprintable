/**
 * story #4320(까디르 QA ④) — BFF 라우트의 **직접** 백엔드 fetch 한 곳. 공용 프록시(proxyToFastapi*)를 안 거치는 라우트(로그인 · 쿠키를
 * 만지는 인증 · 첨부 서명 · 채널 콜백 등)가 쓴다.
 *
 * 왜: 이 PR이 직접 fetch에 시간 제한을 걸면서, 시간 초과가 **새로** 생겼다 — 그대로 두면 fetch · 본문 읽기가 던진 `TimeoutError`가 라우트
 * 밖으로 새어 500이 된다. 공용 프록시와 같은 봉투(503 `UPSTREAM_TIMEOUT` · 원 요청 취소 499)로 돌려준다.
 *
 * - 시간 제한은 **본문까지** 덮는다: 머리를 받은 뒤 본문을 읽다 시간이 다 돼도 503. 그래서 본문을 여기서 다 읽어 새 Response로 넘긴다
 *   (직접 fetch 자리는 전부 본문을 통째로 읽는다 — 흘려보내는 자리 0, event-stream은 이 함수를 안 쓴다).
 * - `timeLimitOnly`: **한 번 쓰는 값을 소비하거나 새 토큰 · 자격을 내는** 호출(로그인 · TOTP · 리프레시 발급 · 초대 수락 · 2FA 설정 ·
 *   결제 · API 키 · 공유 토큰 · OAuth 콜백) — 브라우저가 끊어도 백엔드 호출은 끝까지 간다(끊으면 값은 소비됐는데 결과를 못 받는다).
 *   시간 제한만 건다. 호출 자리에 이유 주석(`시간 제한만`)을 단다(가드).
 * - 그 밖의 오류(연결 실패 등)는 예전처럼 던진다 — 라우트마다의 처리 그대로.
 */
import { apiError } from '@/lib/api-response';
import { backendSignal, BFF_BACKEND_TIMEOUT_MS, classifyBackendAbort } from '@/lib/backend-signal';

export interface BackendFetchInit extends Omit<RequestInit, 'signal'> {
  /** 원 요청 — 브라우저가 끊으면 백엔드 호출도 끊는다(`timeLimitOnly`면 안 넘긴다). 요청 스코프가 없으면 null. */
  request?: Request | null;
  /** 백엔드 응답 **본문까지**의 최대 시간(기본 30초). 긴 라우트는 `bff-route-timeouts`의 이름 붙은 값을 넘긴다. */
  timeoutMs?: number;
  /** 한 번 쓰는 값 · 새 토큰 — 원 요청 취소를 전하지 않는다(시간 제한만). */
  timeLimitOnly?: boolean;
}

const NULL_BODY_STATUSES = new Set([101, 103, 204, 205, 304]);
// 본문을 여기서 풀어(압축 해제된 채) 다시 싣는다 — 원래 길이 · 압축 표시는 거짓이 된다.
const DROP_HEADERS = ['content-encoding', 'content-length', 'transfer-encoding'];

export async function backendFetch(url: string, init: BackendFetchInit = {}): Promise<Response> {
  const { request = null, timeoutMs = BFF_BACKEND_TIMEOUT_MS, timeLimitOnly = false, ...rest } = init;
  const signal = backendSignal(timeLimitOnly ? null : request, timeoutMs);
  try {
    const res = await fetch(url, { ...rest, signal });
    const body = NULL_BODY_STATUSES.has(res.status) ? null : await res.arrayBuffer();
    const headers = new Headers(res.headers);
    for (const h of DROP_HEADERS) headers.delete(h);
    return new Response(body, { status: res.status, statusText: res.statusText, headers });
  } catch (err) {
    const kind = classifyBackendAbort(err);
    if (kind === 'timeout') {
      return apiError('UPSTREAM_TIMEOUT', '서버 응답이 늦어지고 있습니다. 잠시 뒤 다시 시도해 주세요.', 503);
    }
    if (kind === 'client-abort') {
      return apiError('CLIENT_CLOSED_REQUEST', '요청이 취소되었습니다.', 499);
    }
    throw err;
  }
}
