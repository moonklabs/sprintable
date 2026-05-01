/**
 * FastAPI proxy helper — Next.js API Routes에서 FastAPI /api/v2/* 엔드포인트를 호출.
 * Authorization 헤더를 sp_at 쿠키에서 추출해 forwarding.
 */

import { getServerSession } from '@/lib/supabase/server';
import { ApiErrors } from '@/lib/api-response';

const FASTAPI_URL = () => process.env['NEXT_PUBLIC_FASTAPI_URL'] ?? 'http://localhost:8000';

/**
 * sp_at 쿠키에서 access_token 추출 (또는 Authorization 헤더에서 API Key 추출).
 * 인증 실패 시 null 반환.
 */
async function resolveAuthHeader(request: Request): Promise<string | null> {
  // 1. API Key (Authorization 헤더 또는 x-api-key)
  const authHeader = request.headers.get('Authorization');
  const xApiKey = request.headers.get('x-api-key');
  if (authHeader?.startsWith('Bearer ') || xApiKey) {
    return authHeader ?? `Bearer ${xApiKey}`;
  }

  // 2. JWT 쿠키
  const session = await getServerSession();
  if (session?.access_token) {
    return `Bearer ${session.access_token}`;
  }

  return null;
}

interface ProxyOptions {
  /** 인증 없이도 허용할 경우 true */
  public?: boolean;
}

/**
 * 요청을 FastAPI /api/v2/* 로 proxy.
 * 인증 헤더를 자동으로 추출해 forwarding.
 */
export async function proxyToFastapi(
  request: Request,
  fastapiPath: string,
  options: ProxyOptions = {},
): Promise<Response> {
  const authHeader = await resolveAuthHeader(request);
  if (!authHeader && !options.public) {
    return ApiErrors.unauthorized();
  }

  const url = new URL(request.url);
  const targetUrl = `${FASTAPI_URL()}${fastapiPath}${url.search}`;

  const headers: Record<string, string> = {
    'Content-Type': request.headers.get('Content-Type') ?? 'application/json',
  };
  if (authHeader) headers['Authorization'] = authHeader;

  // 일부 헤더 forward
  for (const h of ['x-forwarded-for', 'x-real-ip', 'x-api-key']) {
    const v = request.headers.get(h);
    if (v) headers[h] = v;
  }

  const hasBody = request.method !== 'GET' && request.method !== 'HEAD';
  const body = hasBody ? await request.text() : undefined;

  const res = await fetch(targetUrl, {
    method: request.method,
    headers,
    body,
  });

  const resBody = await res.text();
  return new Response(resBody, {
    status: res.status,
    headers: { 'Content-Type': res.headers.get('Content-Type') ?? 'application/json' },
  });
}

/**
 * 동적 라우트 파라미터를 포함한 path를 FastAPI로 proxy.
 * 예: proxyToFastapiPath(request, '/api/v2/agent-runs', { id: '123' })
 *   → GET /api/v2/agent-runs/123
 */
export async function proxyToFastapiWithParams(
  request: Request,
  basePath: string,
  params: Record<string, string>,
  options: ProxyOptions = {},
): Promise<Response> {
  let path = basePath;
  for (const [key, value] of Object.entries(params)) {
    path = path.replace(`[${key}]`, value);
  }
  return proxyToFastapi(request, path, options);
}
