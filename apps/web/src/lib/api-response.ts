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
): NextResponse<ApiErrorResponse> {
  return NextResponse.json({
    data: null,
    error: details ? { code, message, details } : { code, message },
    meta: null,
  }, { status });
}

export function apiUpgradeRequired(message: string, meterType: string, status = 403) {
  return apiError('UPGRADE_REQUIRED', message, status, { meterType });
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
