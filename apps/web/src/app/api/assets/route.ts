import { apiSuccess } from '@/lib/api-response';

import { proxyToFastapi } from '@/lib/fastapi-proxy';

// GET /api/assets?project_id&folder_id?&mime?&q?&sort&order&cursor?&limit
// → FastAPI /api/v2/assets ({ items: Asset[], next_cursor: string|null })
export async function GET(request: Request) {
  const _r = await proxyToFastapi(request, '/api/v2/assets');
  if (!_r.ok) return _r;
  if (_r.status === 204) return apiSuccess({ ok: true });
  return apiSuccess(await _r.json());
}
