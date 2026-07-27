import { handleApiError } from '@/lib/api-error';
import { apiSuccess, ApiErrors } from '@/lib/api-response';
import { getAuthContext } from '@/lib/auth-helpers';
import { proxyToFastapi } from '@/lib/fastapi-proxy';

type RouteParams = { params: Promise<{ id: string }> };

/**
 * POST /api/visual-artifacts/{id}/edit — E-CANVAS C3-S7 딸깍 편집(휴먼) 커밋.
 * MCP `sprintable_edit_artifact`(에이전트)와 **동일 BE 엔드포인트**(`_apply_artifact_edit`)로
 * 프록시 — operations diff를 적용해 새 버전 생성. artifact.updated 이벤트는 BE가 dispatch
 * (휴먼↔에이전트 양방향 도달). 신규 BE 0·프록시 plumbing만.
 */
export async function POST(request: Request, { params }: RouteParams) {
  try {
    const { id } = await params;
    const me = await getAuthContext(request);
    if (!me) return ApiErrors.unauthorized();
    const _r = await proxyToFastapi(request, `/api/v2/visual-artifacts/${id}/edit`);
    if (!_r.ok) return _r;
    const json = (await _r.json()) as { data?: unknown };
    return apiSuccess(json.data ?? null, undefined, 201);
  } catch (err: unknown) { return handleApiError(err); }
}
