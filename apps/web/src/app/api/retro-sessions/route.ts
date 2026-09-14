import { handleApiError } from '@/lib/api-error';
import { apiSuccess, ApiErrors } from '@/lib/api-response';
import { getOrgProjectAuthContext } from '@/lib/auth-helpers';
import { proxyToFastapi } from '@/lib/fastapi-proxy';
import { buildHeaderCursorPageMeta } from '@/lib/pagination';

// GET /api/retro-sessions?project_id=X
export async function GET(request: Request) {
  try {
    const me = await getOrgProjectAuthContext(request);
    if (!me) return ApiErrors.unauthorized();
    if (me.rateLimitExceeded) return ApiErrors.tooManyRequests(me.rateLimitRemaining, me.rateLimitResetAt);

    const _r = await proxyToFastapi(request, '/api/v2/retros');
    if (!_r.ok) return _r;
    if (_r.status === 204) return apiSuccess({ ok: true });
    const data = await _r.json();

    // story #3857 — BE list_sessions(retros.py, #2428 PR④)가 X-Total-Count·X-Next-Cursor를
    // 내는데 이 라우트가 body만 취해 헤더를 버려 왔다(stories/backlog/route.ts #2190과 동일
    // 결함 클래스). PO CHANGES①(2026-09-14 09:01Z) — X-Next-Cursor는 페이지가 비어 있지
    // 않으면 항상 실리므로(retros.py:155) 존재 자체가 「더 있음」의 증거가 아니다. 판정은
    // pagination.ts::buildHeaderCursorPageMeta로 위임.
    const { searchParams } = new URL(request.url);
    const requestedLimit = Number(searchParams.get('limit')) || 1000; // BE 미지정 시 기존 동작(최대 1000)과 동일
    const hasCursorParam = Boolean(searchParams.get('cursor'));
    const nextCursor = _r.headers.get('x-next-cursor');
    const totalHeader = _r.headers.get('x-total-count');

    return apiSuccess(data, buildHeaderCursorPageMeta({
      dataLength: Array.isArray(data) ? data.length : 0,
      requestedLimit,
      hasCursorParam,
      nextCursorHeader: nextCursor,
      totalCountHeader: totalHeader !== null ? Number(totalHeader) : null,
    }));
  } catch (err: unknown) {
    return handleApiError(err);
  }
}

// POST /api/retro-sessions
export async function POST(request: Request) {
  try {
    const me = await getOrgProjectAuthContext(request);
    if (!me) return ApiErrors.unauthorized();
    if (me.rateLimitExceeded) return ApiErrors.tooManyRequests(me.rateLimitRemaining, me.rateLimitResetAt);

    const _r = await proxyToFastapi(request, '/api/v2/retros');
    if (!_r.ok) return _r;
    if (_r.status === 204) return apiSuccess({ ok: true });
    return apiSuccess(await _r.json())
  } catch (err: unknown) {
    return handleApiError(err);
  }
}
