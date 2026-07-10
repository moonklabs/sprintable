import { handleApiError } from '@/lib/api-error';
import { apiSuccess, ApiErrors } from '@/lib/api-response';
import { getAuthContext } from '@/lib/auth-helpers';
import { proxyToFastapi } from '@/lib/fastapi-proxy';

/**
 * GET /api/visual-artifacts?story_id=|epic_id=|doc_id= — E-CANVAS C1-S3(BE 계약
 * `e-canvas-c1-be-contract` §4). BE 라우터/모델 자체가 아직 미구현(§6 체크리스트 미완)이라
 * 지금은 항상 404를 그대로 프록시한다 — story-detail-panel의 ArtifactSection이 그 404를
 * "이 스토리엔 첨부 없음"과 동일하게 조용히 처리(회귀 없음, mock 폴백 없음).
 */
export async function GET(request: Request) {
  try {
    const me = await getAuthContext(request);
    if (!me) return ApiErrors.unauthorized();
    const _r = await proxyToFastapi(request, '/api/v2/visual-artifacts');
    if (!_r.ok) return _r;
    return apiSuccess(await _r.json());
  } catch (err: unknown) { return handleApiError(err); }
}
