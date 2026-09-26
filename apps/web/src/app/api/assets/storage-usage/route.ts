import { apiSuccess } from '@/lib/api-response';

import { proxyToFastapi } from '@/lib/fastapi-proxy';
import { withRouteTiming } from '@/lib/server-timing';

// GET /api/assets/storage-usage
// → FastAPI /api/v2/assets/storage-usage ({ org_id, used_bytes, limit_bytes, percentage })
// BE derives the org from the JWT; proxyToFastapi forwards query params + auth verbatim.
// story #4299 AC2 — 라우트 전체 계측(합계 · bff_pre · 인증 /me 포함 모든 백엔드 호출 · dev 전용 · 꺼지면 그대로 호출).
export const GET = withRouteTiming('storage-usage', async (request: Request) => {
  const _r = await proxyToFastapi(request, '/api/v2/assets/storage-usage');
  if (!_r.ok) return _r;
  if (_r.status === 204) return apiSuccess({ ok: true });
  return apiSuccess(await _r.json());
});
