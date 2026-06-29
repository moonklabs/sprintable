import { apiSuccess } from '@/lib/api-response';

import { proxyToFastapi } from '@/lib/fastapi-proxy';

// GET /api/folders?project_id → FastAPI /api/v2/folders (Folder[])
export async function GET(request: Request) {
  const _r = await proxyToFastapi(request, '/api/v2/folders');
  if (!_r.ok) return _r;
  if (_r.status === 204) return apiSuccess({ ok: true });
  return apiSuccess(await _r.json());
}
