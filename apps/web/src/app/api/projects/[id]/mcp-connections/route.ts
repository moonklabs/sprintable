import { handleApiError } from '@/lib/api-error';
import { apiSuccess } from '@/lib/api-response';
import { proxyToFastapi } from '@/lib/fastapi-proxy';

type RouteParams = { params: Promise<{ id: string }> };

export async function GET(_request: Request, { params }: RouteParams) {
  try {
    const { id } = await params;
    return apiSuccess({ project_id: id, connections: [] });
  } catch (error) {
    return handleApiError(error);
  }
}

export async function POST(request: Request, _ctx: RouteParams) {
const _r = await proxyToFastapi(request, '/api/v2/projects/mcp-connections');
  if (!_r.ok) return _r;
  if (_r.status === 204) return apiSuccess({ ok: true });
  return apiSuccess(await _r.json())
}
