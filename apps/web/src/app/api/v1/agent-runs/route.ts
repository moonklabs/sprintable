import { apiSuccess, ApiErrors } from '@/lib/api-response';
import { handleApiError } from '@/lib/api-error';
import { createAgentRunRepository } from '@/lib/storage/factory';
import { normalizeRunStatusFilter } from '@/services/agent-run-history';
import { proxyToFastapi } from '@/lib/fastapi-proxy';
import { getAuthContext } from '@/lib/auth-helpers';

const PAGE_SIZE = 20;

export async function GET(request: Request) {
const _r = await proxyToFastapi(request, '/api/v2/agent-runs');
  if (!_r.ok) return _r;
  if (_r.status === 204) return apiSuccess({ ok: true });
  return apiSuccess(await _r.json())
}

export async function POST(request: Request) {
const _r = await proxyToFastapi(request, '/api/v2/agent-runs');
  if (!_r.ok) return _r;
  if (_r.status === 204) return apiSuccess({ ok: true });
  return apiSuccess(await _r.json())
}
