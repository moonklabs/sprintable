import { apiSuccess } from '@/lib/api-response';
import { proxyToFastapi } from '@/lib/fastapi-proxy';

// GET /api/context-pack/search?project_id=X&query=text&limit=N — E-SPRINT-LOOP L1 선례 조력
// (278314e9 §5). BE `/api/v2/context-pack/search`(P1-S6) raw passthrough — query params 그대로
// forward(project_id/query/limit). embed 서비스 미가용(503)/결과 0건은 소비부가 섹션 자체
// 생략으로 흡수(nullable graceful, 크래시 0).
export async function GET(request: Request) {
  const _r = await proxyToFastapi(request, '/api/v2/context-pack/search');
  if (!_r.ok) return _r;
  if (_r.status === 204) return apiSuccess([]);
  return apiSuccess(await _r.json());
}
