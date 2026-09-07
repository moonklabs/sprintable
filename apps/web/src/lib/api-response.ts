import { NextResponse } from 'next/server';

/**
 * 표준 API 응답 형식 (정책 7.3)
 *
 * 성공: { data: T, error: null, meta?: { total?, page?, limit? } }
 * 실패: { data: null, error: { code: string, message: string, details?: Record<string, unknown> }, meta: null }
 */

export interface ApiMeta {
  total?: number;
  page?: number;
  limit?: number;
  [key: string]: unknown;
}

export interface ApiSuccessResponse<T> {
  data: T;
  error: null;
  meta: ApiMeta | null;
}

export interface ApiErrorPayload {
  code: string;
  message: string;
  details?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface ApiErrorResponse {
  data: null;
  error: ApiErrorPayload;
  meta: null;
}

/** 성공 응답 */
export function apiSuccess<T>(data: T, meta?: ApiMeta, status = 200): NextResponse<ApiSuccessResponse<T>> {
  return NextResponse.json({ data, error: null, meta: meta ?? null }, { status });
}

/** 에러 응답 */
export function apiError(
  code: string,
  message: string,
  status = 400,
  details?: Record<string, unknown>,
  // story #3998 CHANGES(카디르 codex 발견, 2026-09-07) — fastapi-proxy.ts의
  // UPSTREAM_NON_JSON 분기가 이미 계산해 둔 Retry-After를 실을 길이 없어(이
  // 함수가 headers를 아예 못 받음) 3516이 한 번 고쳤던 헤더 소실이 재발했다.
  // 선택 인자 additive — 기존 호출부 전부 그대로(undefined→헤더 오버라이드 0).
  headers?: Record<string, string>,
): NextResponse<ApiErrorResponse> {
  return NextResponse.json({
    data: null,
    error: details ? { code, message, details } : { code, message },
    meta: null,
  }, headers ? { status, headers } : { status });
}

export function apiUpgradeRequired(message: string, meterType: string, status = 403) {
  return apiError('UPGRADE_REQUIRED', message, status, { meterType });
}

// story #3644(3632 후속, AC8) — 직접 fetch(proxyToFastapi 미경유) 12 라우트가
// `await fastapiRes.json()`을 !ok 검사 「위」에서 불러, 상류가 비-JSON(CF가
// 502/504를 자기 HTML로 바꿔치는 자리)을 내면 여기서 던져 이미 적혀 있는 폴백
// 봉투 줄에 영영 도달 못 하고 Next.js가 자기 500 HTML을 낸다(로그인·토큰
// 갱신·조직 전환 경로 포함). text()로 읽어 안전하게 파싱 — 실패하면 빈 객체를
// 반환해 호출부의 기존 `json.error ?? {...fallback}` 줄이 그대로 그 폴백을
// 쓰게 한다(새 봉투 형 발명 0, 폴백은 각 라우트가 이미 갖고 있던 것).
export async function safeJsonParse(res: Response): Promise<Record<string, unknown>> {
  // 기존 라우트 테스트 다수가 fetch 응답을 `{status, json: async () => ...}` 형
  // 플레인 객체로 mock한다(.text() 없음) — 실 Response에서는 .text()로 읽어
  // JSON.parse가 실 파싱 실패를 잡아내지만, 그 mock 형에서는 .text가 함수가
  // 아니므로 이미 파싱된 값을 내는 .json()으로 안전하게 폴백한다.
  if (typeof res.text !== 'function') {
    try {
      return (await res.json()) as Record<string, unknown>;
    } catch {
      return {};
    }
  }
  const text = await res.text();
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** 자주 쓰는 에러 숏컷 */
export const ApiErrors = {
  unauthorized: () => apiError('UNAUTHORIZED', 'Unauthorized', 401),
  forbidden: (msg = 'Forbidden') => apiError('FORBIDDEN', msg, 403),
  insufficientScope: (required: string) => apiError('FORBIDDEN', 'Insufficient scope', 403, { error: 'insufficient_scope', required }),
  notFound: (msg = 'Not found') => apiError('NOT_FOUND', msg, 404),
  badRequest: (msg: string) => apiError('BAD_REQUEST', msg, 400),
  validationFailed: (issues: Array<{ path: string; message: string }>) =>
    NextResponse.json({
      data: null,
      error: { code: 'VALIDATION_FAILED', message: 'Validation failed', issues },
      meta: null,
    }, { status: 400 }),
  tooManyRequests: (remaining = 0, resetAt = 0) =>
    new Response(JSON.stringify({ error: 'Rate limit exceeded' }), {
      status: 429,
      headers: {
        'Content-Type': 'application/json',
        'X-RateLimit-Limit': '300',
        'X-RateLimit-Remaining': String(remaining),
        'X-RateLimit-Reset': String(resetAt),
        'Retry-After': String(Math.max(0, Math.ceil((resetAt - Date.now()) / 1000))),
      },
    }),
} as const;
