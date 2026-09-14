
import { proxyToFastapi } from '@/lib/fastapi-proxy';
import { handleApiError } from '@/lib/api-error';
import { apiSuccess, ApiErrors } from '@/lib/api-response';
import { getOrgProjectAuthContext } from '@/lib/auth-helpers';

// GET /api/standup?project_id=...&date=YYYY-MM-DD[&member_id=...]
export async function GET(request: Request) {
  try {
    const me = await getOrgProjectAuthContext(request);
    if (!me) return ApiErrors.unauthorized();
    if (me.rateLimitExceeded) return ApiErrors.tooManyRequests(me.rateLimitRemaining, me.rateLimitResetAt);

    const _r = await proxyToFastapi(request, '/api/v2/standups');
    if (!_r.ok) return _r;
    if (_r.status === 204) return apiSuccess({ ok: true });
    const data = await _r.json();

    // story #3857 — BE list_standups(story #3841)가 X-Total-Count·X-Next-Cursor를 내는데
    // 이 라우트가 body만 취해 헤더를 버려 왔다(stories/backlog/route.ts #2190과 동일
    // 결함 클래스). over-fetch 없이 정확히 limit개만 주므로 "받은 개수===요청 limit"일
    // 때만 다음 페이지 여지가 있다고 본다.
    const { searchParams } = new URL(request.url);
    const requestedLimit = Number(searchParams.get('limit')) || 1000; // BE Query(default=1000)와 동일
    const nextCursor = _r.headers.get('x-next-cursor');
    const totalHeader = _r.headers.get('x-total-count');
    const hasMore = Array.isArray(data) && data.length === requestedLimit && nextCursor !== null;

    return apiSuccess(data, {
      limit: requestedLimit,
      hasMore,
      nextCursor: hasMore ? nextCursor : null,
      totalCount: totalHeader !== null ? Number(totalHeader) : null,
    });
  } catch (err: unknown) {
    return handleApiError(err);
  }
}

// POST /api/standup
export async function POST(request: Request) {
  try {
    const me = await getOrgProjectAuthContext(request);
    if (!me) return ApiErrors.unauthorized();
    if (me.rateLimitExceeded) return ApiErrors.tooManyRequests(me.rateLimitRemaining, me.rateLimitResetAt);

    const _r = await proxyToFastapi(request, '/api/v2/standups');
    if (!_r.ok) return _r;
    if (_r.status === 204) return apiSuccess({ ok: true });
    return apiSuccess(await _r.json());
  } catch (err: unknown) {
    return handleApiError(err);
  }
}

// PUT /api/standup — kept for backwards compatibility
export async function PUT(request: Request) {
  try {
    const me = await getOrgProjectAuthContext(request);
    if (!me) return ApiErrors.unauthorized();
    if (me.rateLimitExceeded) return ApiErrors.tooManyRequests(me.rateLimitRemaining, me.rateLimitResetAt);

    const _r = await proxyToFastapi(request, '/api/v2/standups');
    if (!_r.ok) return _r;
    if (_r.status === 204) return apiSuccess({ ok: true });
    return apiSuccess(await _r.json());
  } catch (err: unknown) {
    return handleApiError(err);
  }
}
