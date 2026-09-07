/**
 * FastAPI proxy helper — Next.js API Routes에서 FastAPI /api/v2/* 엔드포인트를 호출.
 * Authorization 헤더를 sp_at 쿠키에서 추출해 forwarding.
 */

import { getServerSession } from '@/lib/db/server';
import { apiError, apiSuccess, ApiErrors } from '@/lib/api-response';

// story #2499 — 이 파일이 packages/storage-api/src/utils.ts와 완전 동일한 mapApiError/
// fastapiCall 사본을 따로 갖고 있어(#2488에서 같은 버그를 두 곳에 각각 고쳐야 했다),
// 다음 소비처가 조용히 옛 버그를 다시 밟을 위험이 있었다. 단일 구현으로 합친다 —
// storage-api 쪽이 더 견고함(AbortSignal.timeout(30s) 포함)도 이 자리에서 얻는다.
export { fastapiCall, mapApiError } from '@sprintable/storage-api';
export type { ApiCallError } from '@sprintable/storage-api';

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

  let res: Response;
  try {
    res = await fetch(targetUrl, {
      method: request.method,
      headers,
      body,
    });
  } catch {
    // story #3644(3632 후속, «봉투가 사라지는» 자리 전수) — DNS 실패·connection refused·
    // abort 등 fetch() 자체가 던지면 이 아래 코드가 전혀 안 돈다 — 어떤 라우트도 자기
    // 몫의 오류 처리를 못 받는다. grep 실측: `if (!_r.ok) return _r` 형이 244개 라우트
    // 파일에 290곳 — 스토리가 지목한 "BFF 10곳"은 이 공유 프록시를 통해 훨씬 넓은
    // 범위와 같은 병을 앓고 있었다(최소치였다). 라우트마다 고치는 대신 이 프록시
    // 자리 하나에서 막아 소비 라우트 전부(244+)가 물려받게 한다.
    //
    // status=503(502 아님) — PO 決(2026-09-07): CF가 origin 502/504를 자기 HTML로
    // 바꿔치는 자리라(story #3632 그라운딩과 같은 결정) "우리 상태"의 502가 아니라
    // "진짜 상류 실패"의 503 계열로 분류한다.
    return apiError('UPSTREAM_UNREACHABLE', '서버에 연결할 수 없습니다. 잠시 뒤 다시 시도해 주세요.', 503);
  }

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
  // story #3517(PO REQUIRED 1, 2026-09-05) — 429 COMMENT_REFRESH_RATE_LIMITED가
  // Retry-After 초를 들고 오는데, 이 허용목록에 없어 프록시가 조용히 버려 왔다
  // (comments/refresh route는 res.headers.get('Retry-After')를 읽지만 이 함수를
  // 거치면 늘 null이었다 — route 단위 테스트는 proxyToFastapiWithParams 자체를
  // mock해서 이 통과 실패를 못 잡았다). 429를 내는 다른 소비부(예: #3495 발행 429)도
  // 이 프록시를 거치면 같은 이유로 초를 못 받고 있었을 수 있다 — grep해 영향 범위를
  // 스토리/PR에 남길 것.
  for (const h of ['x-total-count', 'x-next-cursor', 'retry-after']) {
    const v = res.headers.get(h);
    if (v) resHeaders[h] = v;
  }
  // story #2349 라이브 검증(미르코) 실측 — null-body status(101/103/204/205/304)에는 Response
  // 생성자가 bodyInit을 null/undefined 대신 빈 문자열('')로 받으면 던진다("Invalid response
  // status code 204" — Node 25/undici). BE가 spec대로 204+빈 바디를 내면 이 프록시가 그걸
  // 그대로 500으로 바꿔버리던 것 — 사용자는 "실패"로 보지만 실제로는 BE 쪽 작업이 이미 끝난
  // 상태(예: DELETE user-blocks — 차단 해제는 됐는데 화면엔 에러 토스트가 뜨는 사고).
  const NULL_BODY_STATUSES = new Set([101, 103, 204, 205, 304]);
  if (NULL_BODY_STATUSES.has(res.status)) {
    return new Response(null, { status: res.status, headers: resHeaders });
  }
  // story #3644(3632 처방 재사용 — 새 상태기계 0) — CF가 502/504 등 상류 실패를 자기
  // HTML 오류 페이지로 바꿔치면(story #3632 그라운딩) status는 보존되지만 본문은
  // JSON이 아니게 된다. BE가 낸 진짜 JSON 오류 봉투(전역 핸들러가 이미 구성한 것)는
  // 파싱이 성공하니 그대로 통과 — 상류 status를 이 프록시가 재해석하지 않는다(그건
  // 각 BE 라우터의 classify_failure_kind 몫). 파싱이 안 되는 경우만 새 봉투로 감싼다.
  if (!res.ok) {
    try {
      JSON.parse(resBody);
    } catch {
      // story #3998 CHANGES(카디르 codex 발견, 2026-09-07) — resHeaders(위에서 이미
      // 계산됨)가 이 분기에서 apiError()에 안 실려 통째로 버려졌다 — 3516이 한 번
      // 고쳤던 Retry-After 소실의 재발(CF 429 HTML 오류 페이지도 Retry-After를
      // 실어 보낼 수 있다). resHeaders 전체가 아니라 retry-after만 골라 넘긴다 —
      // resHeaders['Content-Type']은 상류의 원래 타입(HTML이면 text/html)이라 새로
      // 감싸는 JSON 봉투와 안 맞는다(apiError가 스스로 application/json을 낸다).
      const retryAfter = resHeaders['retry-after'];
      return apiError(
        'UPSTREAM_NON_JSON', '서버 응답을 처리할 수 없습니다. 잠시 뒤 다시 시도해 주세요.', res.status,
        undefined, retryAfter ? { 'Retry-After': retryAfter } : undefined,
      );
    }
  }
  return new Response(resBody, {
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
