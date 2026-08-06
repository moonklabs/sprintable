/**
 * FastAPI proxy helper — Next.js API Routes에서 FastAPI /api/v2/* 엔드포인트를 호출.
 * Authorization 헤더를 sp_at 쿠키에서 추출해 forwarding.
 */

import { getServerSession } from '@/lib/db/server';
import { apiSuccess, ApiErrors } from '@/lib/api-response';

import { NotFoundError, ForbiddenError } from '@sprintable/core-storage';

/** story #2488 — packages/storage-api/src/utils.ts의 mapApiError와 완전 동일한
 * 버그(404/403 외 code·status discard)를 가진 사본. 같은 fix를 여기도 적용한다
 * (PO 확定: 이번 PR 스코프, 두 파일 합치는 consolidation은 별개). */
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
  const url = new URL(path, FASTAPI_URL());
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
    try { errBody = await res.json(); } catch { /* ignore */ }
    throw mapApiError(res.status, errBody);
  }

  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

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

  // 일부 헤더 forward — x-project-id(R2): 브라우저 fetch 인터셉터가 주입한 탭 effective project를
  // FastAPI get_verified_org_id override까지 도달시킨다. 빠지면 이 중간 hop이 헤더를 드롭해 무력화.
  for (const h of ['x-forwarded-for', 'x-real-ip', 'x-api-key', 'x-org-id', 'x-project-id']) {
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
  const resHeaders: Record<string, string> = { 'Content-Type': res.headers.get('Content-Type') ?? 'application/json' };
  // story #2190 — board 분기(list_stories status+project_id 조합)가 커서 페이지네이션 신호를
  // 이 두 헤더로만 내보내는데(X-Total-Count/X-Next-Cursor, backend/app/routers/stories.py),
  // 이전에는 Content-Type만 남기고 전부 버려서 호출부(예: stories/backlog route)가 meta를
  // 영영 못 만들어 "더 보기"가 죽어 있었다.
  //
  // ⚠️허용목록만 옮기고 절대 res.headers를 통째로 복사하지 않는다 — 이 함수는 본문을 text()로
  // 다시 읽어 새 Response로 재구성하는 구조라, 원본 헤더를 그대로 넘기면 깨지는 것들이 있다:
  //   Content-Length    재직렬화한 본문과 길이가 안 맞아 응답이 깨짐
  //   Content-Encoding  프록시가 이미 압축을 푼 상태인데 "gzip"이라 말해 클라가 못 읽음
  //   Set-Cookie        백엔드 쿠키가 브라우저로 새어나감 — 보안 표면
  //   Transfer-Encoding 재구성한 응답과 어긋남
  // 다음에 새 헤더가 필요해지면 여기 배열에 명시적으로 추가할 것 — "그냥 다 넘기자"로 되돌리지 말 것.
  for (const h of ['x-total-count', 'x-next-cursor']) {
    const v = res.headers.get(h);
    if (v) resHeaders[h] = v;
  }
  // story #2349 라이브 검증(미르코) 실측 — null-body status(101/103/204/205/304)에는 Response
  // 생성자가 bodyInit을 null/undefined 대신 빈 문자열('')로 받으면 던진다("Invalid response
  // status code 204" — Node 25/undici). BE가 spec대로 204+빈 바디를 내면 이 프록시가 그걸
  // 그대로 500으로 바꿔버리던 것 — 사용자는 "실패"로 보지만 실제로는 BE 쪽 작업이 이미 끝난
  // 상태(예: DELETE user-blocks — 차단 해제는 됐는데 화면엔 에러 토스트가 뜨는 사고).
  const NULL_BODY_STATUSES = new Set([101, 103, 204, 205, 304]);
  return new Response(NULL_BODY_STATUSES.has(res.status) ? null : resBody, {
    status: res.status,
    headers: resHeaders,
  });
}

/**
 * proxyToFastapi + success-body re-wrap. The BE returns raw JSON on success; share/
 * public consumers read `json.data`, so wrap success in the `{ data }` envelope.
 * Errors (already enveloped by the BE global handler) and 204 pass through verbatim.
 * Bypasses the storage-api repo entirely — immune to the stale-dist bundling class.
 */
export async function proxyToFastapiWrapped(
  request: Request,
  fastapiPath: string,
  options: ProxyOptions = {},
): Promise<Response> {
  const res = await proxyToFastapi(request, fastapiPath, options);
  if (!res.ok || res.status === 204) return res;
  const raw = await res.json();
  return apiSuccess(raw);
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
