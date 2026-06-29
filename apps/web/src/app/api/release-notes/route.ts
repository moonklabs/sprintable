import { apiSuccess } from '@/lib/api-response';
import { proxyToFastapi } from '@/lib/fastapi-proxy';

// 릴리즈 노트 조회(de-hardcode·story 53bc0945) — BE `GET /api/v2/release-notes`(published·newest-first).
// CRUD(owner/admin)는 v1 범위 밖(시드/관리 API 직접)·후속 admin UI 때 프록시 추가.
export async function GET(request: Request) {
  const _r = await proxyToFastapi(request, '/api/v2/release-notes');
  if (!_r.ok) return _r;
  if (_r.status === 204) return apiSuccess([]);
  return apiSuccess(await _r.json());
}
