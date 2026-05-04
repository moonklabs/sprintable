import { apiSuccess } from '@/lib/api-response';
import { handleApiError } from '@/lib/api-error';
import { normalizeRunStatusFilter } from '@/services/agent-run-history';
import { proxyToFastapi } from '@/lib/fastapi-proxy';

const PAGE_SIZE = 20;

export async function GET(request: Request) {
  try {
    const _r = await proxyToFastapi(request, '/api/v2/agent-runs');
    if (!_r.ok) return _r;
    if (_r.status === 204) return apiSuccess({ ok: true });
    return apiSuccess(await _r.json());
  } catch (error) { return handleApiError(error); }
}

export async function POST(request: Request) {
  try {
    const _r = await proxyToFastapi(request, '/api/v2/agent-runs');
    if (!_r.ok) return _r;
    if (_r.status === 204) return apiSuccess({ ok: true });
    return apiSuccess(await _r.json());
  } catch (error) { return handleApiError(error); }
}
