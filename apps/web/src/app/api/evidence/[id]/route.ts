import { handleApiError } from '@/lib/api-error';
import { apiSuccess, ApiErrors } from '@/lib/api-response';
import { getAuthContext } from '@/lib/auth-helpers';
import { proxyToFastapi } from '@/lib/fastapi-proxy';

type RouteParams = { params: Promise<{ id: string }> };

/** story #2314 — GET /api/v2/evidence/{id} 신설분 프록시. 형제(GET /api/evidence 리스트)와
 * 동일하게 apiSuccess로 감싼다 — raw passthrough가 필요한 곳(POST evidence)은 소비부가
 * 단건 객체를 그대로 기대해서였지, 이 라우트의 소비부(embed-card.tsx EntityPreviewModal)는
 * `json.data ?? json`로 이미 양쪽 shape를 다 받게 짜여 있어 감싸도 안전하다. */
export async function GET(request: Request, { params }: RouteParams) {
  try {
    const { id } = await params;
    const me = await getAuthContext(request);
    if (!me) return ApiErrors.unauthorized();
    const _r = await proxyToFastapi(request, `/api/v2/evidence/${id}`);
    if (!_r.ok) return _r;
    return apiSuccess(await _r.json());
  } catch (err: unknown) { return handleApiError(err); }
}
