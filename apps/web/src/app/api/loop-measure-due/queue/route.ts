import { handleApiError } from '@/lib/api-error';
import { apiSuccess, ApiErrors } from '@/lib/api-response';
import { getOrgProjectAuthContext } from '@/lib/auth-helpers';
import { proxyToFastapi } from '@/lib/fastapi-proxy';

// story #2858(loop-closure P2, BE #3274) — 읽기전용 프록시. query(project_id?·unclaimed_only?·
// limit·offset)는 raw passthrough(proxyToFastapi가 url.search를 그대로 전달) — FE에서 별도
// 파싱/재조립 없음(BE가 이미 project 접근권 fail-closed 검증, story #2697 패턴).

/** GET /api/loop-measure-due/queue → /api/v2/loop-measure-due/queue */
export async function GET(request: Request) {
  try {
    const me = await getOrgProjectAuthContext(request);
    if (!me) return ApiErrors.unauthorized();
    const _r = await proxyToFastapi(request, '/api/v2/loop-measure-due/queue');
    if (!_r.ok) return _r;
    return apiSuccess(await _r.json());
  } catch (err: unknown) { return handleApiError(err); }
}
