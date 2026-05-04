import { apiSuccess, ApiErrors } from '@/lib/api-response';
import { handleApiError } from '@/lib/api-error';
import { isOssMode, createAgentRunRepository } from '@/lib/storage/factory';
import { normalizeRunStatusFilter } from '@/services/agent-run-history';
import { proxyToFastapi } from '@/lib/fastapi-proxy';

const PAGE_SIZE = 20;

export async function GET(request: Request) {
  if (isOssMode()) {
    try {
      const { OSS_ORG_ID, OSS_PROJECT_ID } = await import('@sprintable/storage-pglite');
      const repo = await createAgentRunRepository();
      const url = new URL(request.url);
      const limit = Math.min(Number(url.searchParams.get('limit') ?? PAGE_SIZE), 50);
      const result = await repo.list({
        orgId: OSS_ORG_ID,
        projectId: OSS_PROJECT_ID,
        status: normalizeRunStatusFilter(url.searchParams.get('status')),
        from: url.searchParams.get('from'),
        to: url.searchParams.get('to'),
        cursor: url.searchParams.get('cursor'),
        limit,
      });
      const enriched = result.items.map((r) => ({ ...r, agent_name: null }));
      return apiSuccess(enriched, { nextCursor: result.nextCursor, hasMore: result.hasMore, limit });
    } catch (error) { return handleApiError(error); }
  }
const _r = await proxyToFastapi(request, '/api/v2/agent-runs');
  if (!_r.ok) return _r;
  if (_r.status === 204) return apiSuccess({ ok: true });
  return apiSuccess(await _r.json())
}

export async function POST(request: Request) {
  if (isOssMode()) return ApiErrors.badRequest('Not available in OSS mode');
const _r = await proxyToFastapi(request, '/api/v2/agent-runs');
  if (!_r.ok) return _r;
  if (_r.status === 204) return apiSuccess({ ok: true });
  return apiSuccess(await _r.json())
}
