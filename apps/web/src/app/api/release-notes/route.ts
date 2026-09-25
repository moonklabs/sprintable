import { apiSuccess } from '@/lib/api-response';
import { proxyToFastapi } from '@/lib/fastapi-proxy';
import { withRouteTiming } from '@/lib/server-timing';

// 릴리즈 노트 조회(de-hardcode·story 53bc0945) — BE `GET /api/v2/release-notes`(published·newest-first).
// CRUD(owner/admin)는 v1 범위 밖(시드/관리 API 직접)·후속 admin UI 때 프록시 추가.
// story #4299 AC2 — 라우트 전체 계측(합계 · bff_pre · 인증 /me 포함 모든 백엔드 호출 · dev 전용 · 꺼지면 그대로 호출).
export const GET = withRouteTiming('release-notes', async (request: Request) => {
  const _r = await proxyToFastapi(request, '/api/v2/release-notes');
  if (!_r.ok) return _r;
  if (_r.status === 204) return apiSuccess([]);
  return apiSuccess(await _r.json());
});
