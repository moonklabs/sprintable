import { apiSuccess, ApiErrors } from '@/lib/api-response';
import { handleApiError } from '@/lib/api-error';
import { createAgentRunRepository } from '@/lib/storage/factory';
import { proxyToFastapi } from '@/lib/fastapi-proxy';
import { getAuthContext } from '@/lib/auth-helpers';

type RouteParams = { params: Promise<{ id: string }> };

export async function GET(request: Request, { params }: RouteParams) {
  const { id } = await params;
const _r = await proxyToFastapi(request, `/api/v2/agent-runs/${id}`);
  if (!_r.ok) return _r;
  if (_r.status === 204) return apiSuccess({ ok: true });
  return apiSuccess(await _r.json())
}

export async function PATCH(request: Request, { params }: RouteParams) {
  const { id } = await params;
const _r = await proxyToFastapi(request, `/api/v2/agent-runs/${id}`);
  if (!_r.ok) return _r;
  if (_r.status === 204) return apiSuccess({ ok: true });
  return apiSuccess(await _r.json())
}
