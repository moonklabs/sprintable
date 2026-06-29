import { apiSuccess } from '@/lib/api-response';

import { proxyToFastapi } from '@/lib/fastapi-proxy';

// GET /api/assets/storage-usage
// → FastAPI /api/v2/assets/storage-usage ({ org_id, used_bytes, limit_bytes, percentage })
// BE derives the org from the JWT; proxyToFastapi forwards query params + auth verbatim.
export async function GET(request: Request) {
  const _r = await proxyToFastapi(request, '/api/v2/assets/storage-usage');
  if (!_r.ok) return _r;
  if (_r.status === 204) return apiSuccess({ ok: true });
  return apiSuccess(await _r.json());
}
