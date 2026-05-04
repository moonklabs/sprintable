import { apiSuccess, ApiErrors } from '@/lib/api-response';
import { handleApiError } from '@/lib/api-error';
import { isOssMode, createAgentRunRepository } from '@/lib/storage/factory';
import { normalizeRunStatusFilter } from '@/services/agent-run-history';
import { proxyToFastapi } from '@/lib/fastapi-proxy';
import { getAuthContext } from '@/lib/auth-helpers';

const PAGE_SIZE = 20;

export async function GET(request: Request) {
  if (isOssMode()) {
    try {
      const me = await getAuthContext(request);
      if (!me) return ApiErrors.unauthorized();
      const repo = await createAgentRunRepository();
      const url = new URL(request.url);
      const limit = Math.min(Number(url.searchParams.get('limit') ?? PAGE_SIZE), 50);
      const result = await repo.list({
        orgId: me.org_id,
        projectId: me.project_id,
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
  if (isOssMode()) {
    try {
      const me = await getAuthContext(request);
      if (!me) return ApiErrors.unauthorized();
      let body: unknown;
      try { body = await request.json(); } catch { body = {}; }
      const b = (body as Record<string, unknown>) ?? {};
      const { getDb } = await import('@sprintable/storage-pglite');
      const { randomUUID } = await import('node:crypto');
      const db = await getDb();
      const id = randomUUID();
      const now = new Date().toISOString();
      await db.query(
        'INSERT INTO agent_runs (id, org_id, project_id, agent_id, session_id, memo_id, story_id, trigger, status, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
        [id, me.org_id, me.project_id, b.agent_id ?? null, b.session_id ?? null, b.memo_id ?? null, b.story_id ?? null, b.trigger ?? null, 'pending', now]
      );
      const run = (await db.query('SELECT * FROM agent_runs WHERE id = $1', [id])).rows[0];
      return apiSuccess(run, undefined, 201);
    } catch (error) { return handleApiError(error); }
  }
const _r = await proxyToFastapi(request, '/api/v2/agent-runs');
  if (!_r.ok) return _r;
  if (_r.status === 204) return apiSuccess({ ok: true });
  return apiSuccess(await _r.json())
}
