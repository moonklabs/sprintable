'use client';

import { isSessionExpiredSignaled, signalSessionExpired } from '@/lib/auth/session-expired-signal';
import { notifySessionChanged } from '@/lib/native-shell-bridge';
import { collectRefreshDiagnostics } from '@/lib/auth/refresh-diagnostics';
import { invalidateMe } from '@/lib/me-client';

// ─── FastAPI Auth Utilities ───────────────────────────────────────────────────

export interface AuthTokens {
  access_token: string;
  refresh_token: string;
  token_type: string;
}

export interface AuthResult {
  data: AuthTokens | null;
  error: { code: string; message: string } | null;
}

async function callAuthRoute(path: string, body: object): Promise<AuthResult> {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json() as { data?: AuthTokens | { ok: boolean }; error?: { code: string; message: string } };
  if (!res.ok) {
    return { data: null, error: json.error ?? { code: 'UNKNOWN', message: 'Unknown error' } };
  }
  // story #3302(#2459 진단 (c)) — login/register/refresh 공통 choke point. 성공은 항상
  // sp_at/sp_rt 쿠키가 새로 세워졌다는 뜻(각 route.ts가 Set-Cookie) — 네이티브 셸에 즉시
  // 알려 디스크로 내리게 한다(강제종료 시 갱신 쿠키 유실 방지, AC1).
  notifySessionChanged();
  invalidateMe();
  return { data: json.data as AuthTokens, error: null };
}

export async function loginWithPassword(
  email: string,
  password: string,
  totpCode?: string,
): Promise<AuthResult> {
  return callAuthRoute('/api/auth/login', { email, password, totp_code: totpCode ?? null });
}

export async function registerUser(email: string, password: string): Promise<AuthResult> {
  return callAuthRoute('/api/auth/register', { email, password });
}

export async function logoutUser(refreshToken?: string): Promise<void> {
  invalidateMe();
  await fetch('/api/auth/logout', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refresh_token: refreshToken ?? '' }),
  });
}

export async function refreshAuthTokens(): Promise<AuthResult> {
  // story #2449 AC1 — 실패 시 BFF(route.ts)가 로깅할 진단 3종(visibility_state·idle_ms·
  // tab_count). collectRefreshDiagnostics는 완전 동기(refresh 호출에 지연을 보태지 않는다
  // — 파일 상단 설계 제약 주석 참고). 서버(SSR)에는 window/document/BroadcastChannel이
  // 없어 그 함수 자체가 typeof 가드로 안전 폴백하지만, 이 함수는 'use client' 모듈이라
  // 브라우저에서만 호출된다 — 방어적으로 유지.
  const diagnostics = typeof window !== 'undefined' ? collectRefreshDiagnostics() : null;
  return callAuthRoute('/api/auth/refresh', diagnostics ? { diagnostics } : {});
}

// ─── 401 인터셉터 fetch 래퍼 ─────────────────────────────────────────────────

let _refreshing: Promise<AuthResult> | null = null;

export async function fetchWithAuth(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  // story #2160 — 세션이 이미 죽었다고 확定된 뒤(SessionExpiredDialog 노출 중)엔 네트워크를
  // 아예 타지 않는다. 안 그러면 401 폴링/재연결 루프가 매 tick마다 refresh를 다시 시도해
  // "401에는 재시도하지 않는다"는 처방이 무력화된다.
  if (typeof window !== 'undefined' && isSessionExpiredSignaled()) {
    return new Response(null, { status: 401 });
  }
  const res = await fetch(input, init);
  if (res.status !== 401) return res;

  // 중복 refresh 방지: 동시 호출 시 하나만 실행
  if (!_refreshing) {
    _refreshing = refreshAuthTokens().finally(() => { _refreshing = null; });
  }
  // story #4089(페드루 PO 리뷰 REQUIRED, AC2 두 번째 클래스) — refreshAuthTokens()(=
  // callAuthRoute)는 BE가 401을 줘도 throw하지 않고 {data:null, error:{...}}로
  // *정상 resolve*한다(위 callAuthRoute 정의 참고) — 그래서 이 함수의 진짜 "refresh
  // 최종 실패" 판정은 catch(네트워크 예외)뿐 아니라 resolve된 결과의 error 필드도
  // 봐야 한다. ⛔예전엔 여기서 안 멈추고 재시도까지 갔다가, 그 **재시도 자체의 401**도
  // signalSessionExpired()를 불렀다(아래 옛 코드) — session-expired 신호를 "이 세션은
  // 죽었다"가 아니라 "방금 이 요청이 401이었다"로 오염시켜, refresh가 실제로 성공해도
  // (세션은 멀쩡해도) BFF route 없이 BE 401을 내는 임의 엔드포인트 하나가 전역
  // SessionExpiredDialog를 띄우는 클래스 결함의 근원이었다(material-lineage 실사고,
  // BFF route 자체를 다 갖춰도 이 클래스는 남는다 — 페드루 PO 지적). 처방: 신호는
  // "refresh가 최종적으로 실패했다"(예외 또는 error 필드)는 사실 하나에서만 나온다 —
  // 재시도 응답은 그 401이 세션 문제인지 그 엔드포인트만의 문제인지 이 함수가 원천적으로
  // 구분할 수 없으므로 신호를 안 낸다(호출부가 자기 401을 알아서 처리).
  let refreshResult: AuthResult;
  try {
    refreshResult = await _refreshing;
  } catch {
    if (typeof window !== 'undefined') signalSessionExpired();
    return res;
  }
  if (refreshResult.error) {
    if (typeof window !== 'undefined') signalSessionExpired();
    return res;
  }

  return fetch(input, init);
}

// ─── Rate-limited fetch helper ────────────────────────────────────────────────

const rateLimitBlockedUntil = new Map<string, number>();

function getUrlKey(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return (input as Request).url;
}

export function rateLimitedFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = getUrlKey(input);
  const now = Date.now();
  const blockedUntil = rateLimitBlockedUntil.get(url);
  if (blockedUntil && now < blockedUntil) {
    const remainingSec = Math.ceil((blockedUntil - now) / 1000);
    return Promise.reject(new Error(`rate_limit_backoff:${remainingSec}`));
  }
  return globalThis.fetch(input, init).then(async (response) => {
    if (response.status === 429) {
      const retryAfterHeader = response.headers.get('Retry-After');
      const retrySeconds = parseInt(retryAfterHeader ?? '', 10);
      const backoffSec = !isNaN(retrySeconds) ? Math.max(retrySeconds, 60) : 60;
      rateLimitBlockedUntil.set(url, Date.now() + backoffSec * 1000);
    }
    return response;
  });
}

// ─── DB Browser Client stub (auth via FastAPI) ─────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function createBrowserClient(): any {
  return undefined;
}
