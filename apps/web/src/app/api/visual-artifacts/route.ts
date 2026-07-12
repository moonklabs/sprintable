import { handleApiError } from '@/lib/api-error';
import { apiSuccess, ApiErrors } from '@/lib/api-response';
import { getAuthContext } from '@/lib/auth-helpers';
import { proxyToFastapi } from '@/lib/fastapi-proxy';

/**
 * GET /api/visual-artifacts?story_id=|epic_id=|doc_id= — E-CANVAS C1-S3.
 *
 * BE 라우터(`visual_artifacts.py`)는 `_ok()` 헬퍼로 이미 `{data, error, meta}` 봉투를 씌워
 * 응답한다 — `apiSuccess(await _r.json())`로 그대로 다시 감싸면 `{data:{data:[...],...},...}`
 * **이중 봉투**가 되어 소비부(`ArtifactSection`)가 `listJson.data`를 배열이 아닌 봉투 객체로
 * 받아 조용히 빈 목록으로 degrade한다(라이브 검증 中 발견 — 실 artifact가 있어도 무표시).
 * FastAPI 응답의 `.data`만 벗겨서 재포장한다.
 */
export async function GET(request: Request) {
  try {
    const me = await getAuthContext(request);
    if (!me) return ApiErrors.unauthorized();
    const _r = await proxyToFastapi(request, '/api/v2/visual-artifacts');
    if (!_r.ok) return _r;
    const json = (await _r.json()) as { data?: unknown };
    return apiSuccess(json.data ?? []);
  } catch (err: unknown) { return handleApiError(err); }
}
