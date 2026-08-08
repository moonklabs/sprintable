import { NotFoundError, ForbiddenError } from '@sprintable/core-storage';

export function mapSupabaseError(error: { code?: string; message: string }): Error {
  if (error.code === 'PGRST116') return new NotFoundError(error.message);
  if (error.code === '42501') return new ForbiddenError('Permission denied');
  return new Error(error.message);
}

/** story #2488 — mapApiError는 404/403 외 status·error.code를 전부 discard해
 * FE의 error.code 분기가 원천적으로 도달 불가능했다(#2484/#2485 error.code 하드닝의
 * 전제를 깨는 병). code·status를 던지는 에러 객체에 실어 보존한다 — NotFoundError/
 * ForbiddenError instanceof 특례는 그대로 유지(전수 소비처 그라운딩 확認: 아무도
 * property 개수·JSON.stringify 모양에 의존하지 않음, 안전한 additive 변경). */
export interface ApiCallError extends Error {
  code?: string;
  status?: number;
}

export function mapApiError(status: number, body: { error?: { code?: string; message?: string } }): ApiCallError {
  const msg = body.error?.message ?? `HTTP ${status}`;
  const code = body.error?.code;
  if (status === 404) return Object.assign(new NotFoundError(msg), { code: code ?? 'NOT_FOUND', status });
  if (status === 403) return Object.assign(new ForbiddenError(msg), { code: code ?? 'FORBIDDEN', status });
  return Object.assign(new Error(msg), { code: code ?? `HTTP_${status}`, status });
}

function getBaseUrl(): string {
  return (
    (typeof process !== 'undefined' && process.env['NEXT_PUBLIC_FASTAPI_URL']) ||
    'http://localhost:8000'
  );
}

export async function fastapiCall<T>(
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE' | 'PUT',
  path: string,
  accessToken: string,
  options?: {
    body?: unknown;
    query?: Record<string, string | number | boolean | null | undefined>;
    orgId?: string;
  },
): Promise<T> {
  const url = new URL(path, getBaseUrl());
  if (options?.query) {
    for (const [k, v] of Object.entries(options.query)) {
      if (v != null) url.searchParams.set(k, String(v));
    }
  }

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (accessToken) headers['Authorization'] = `Bearer ${accessToken}`;
  if (options?.orgId) headers['X-Org-Id'] = options.orgId;

  const res = await fetch(url.toString(), {
    method,
    headers,
    body: options?.body !== undefined ? JSON.stringify(options.body) : undefined,
    signal: AbortSignal.timeout(30_000),
  });

  if (!res.ok) {
    let errBody: { error?: { code?: string; message?: string } } = {};
    try { errBody = await res.json() as typeof errBody; } catch { /* ignore parse error */ }
    throw mapApiError(res.status, errBody);
  }

  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}
