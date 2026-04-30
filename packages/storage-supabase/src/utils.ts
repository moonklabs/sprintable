import { NotFoundError, ForbiddenError } from '@sprintable/core-storage';

export function mapSupabaseError(error: { code?: string; message: string }): Error {
  if (error.code === 'PGRST116') return new NotFoundError(error.message);
  if (error.code === '42501') return new ForbiddenError('Permission denied');
  return new Error(error.message);
}

export function mapApiError(status: number, body: { error?: { code?: string; message?: string } }): Error {
  const msg = body.error?.message ?? `HTTP ${status}`;
  if (status === 404) return new NotFoundError(msg);
  if (status === 403) return new ForbiddenError(msg);
  return new Error(msg);
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
  });

  if (!res.ok) {
    let errBody: { error?: { code?: string; message?: string } } = {};
    try { errBody = await res.json(); } catch { /* ignore parse error */ }
    throw mapApiError(res.status, errBody);
  }

  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}
