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

interface FastapiCallOptions {
  body?: unknown;
  query?: Record<string, string | number | boolean | null | undefined>;
  orgId?: string;
}

async function fastapiCallRaw<T>(
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE' | 'PUT',
  path: string,
  accessToken: string,
  options?: FastapiCallOptions,
): Promise<{ data: T; headers: Headers }> {
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

  const data = res.status === 204 ? (undefined as T) : (await res.json() as T);
  return { data, headers: res.headers };
}

export async function fastapiCall<T>(
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE' | 'PUT',
  path: string,
  accessToken: string,
  options?: FastapiCallOptions,
): Promise<T> {
  const { data } = await fastapiCallRaw<T>(method, path, accessToken, options);
  return data;
}

/** story #3718 — fastapiCall과 완전히 같은 요청·같은 에러 처리를 타되, 응답 헤더까지
 * 호출부에 넘긴다(fastapiCall은 body만 반환해 X-Total-Count 같은 헤더가 소비처에
 * 안 갔다 — ApiTaskRepository.count()가 이걸로 진짜 총계를 읽는다). 중복 구현 대신
 * fastapiCallRaw를 공유해 fastapiCall의 기존 동작(호출부 무회귀)은 그대로 유지한다. */
export async function fastapiCallWithMeta<T>(
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE' | 'PUT',
  path: string,
  accessToken: string,
  options?: FastapiCallOptions,
): Promise<{ data: T; headers: Headers }> {
  return fastapiCallRaw<T>(method, path, accessToken, options);
}
