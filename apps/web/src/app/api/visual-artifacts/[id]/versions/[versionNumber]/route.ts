import { handleApiError } from '@/lib/api-error';
import { apiSuccess, ApiErrors } from '@/lib/api-response';
import { getAuthContext } from '@/lib/auth-helpers';
import { proxyToFastapi } from '@/lib/fastapi-proxy';

type RouteParams = { params: Promise<{ id: string; versionNumber: string }> };

/**
 * GET /api/visual-artifacts/{id}/versions/{versionNumber} — story 3d888ba2. 특정 버전의
 * nodes 포함 상세(신규 BE 0 — `GET /api/v2/visual-artifacts/{id}/versions/{version_number}`은
 * 이미 존재, `[id]/route.ts`의 최신 버전 조회와 동일 `_load_detail` 함수를 버전 지정으로 씀).
 * 갤러리 변천사에서 특정 버전 클릭→그 버전 실물 렌더에 쓰인다.
 */
export async function GET(request: Request, { params }: RouteParams) {
  try {
    const { id, versionNumber } = await params;
    const me = await getAuthContext(request);
    if (!me) return ApiErrors.unauthorized();
    const _r = await proxyToFastapi(request, `/api/v2/visual-artifacts/${id}/versions/${versionNumber}`);
    if (!_r.ok) return _r;
    const json = (await _r.json()) as { data?: unknown };
    return apiSuccess(json.data ?? null);
  } catch (err: unknown) { return handleApiError(err); }
}
