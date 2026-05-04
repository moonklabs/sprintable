import { apiSuccess, ApiErrors } from '@/lib/api-response';
import { handleApiError } from '@/lib/api-error';
import { isOssMode, createAgentRunRepository } from '@/lib/storage/factory';
import { proxyToFastapi } from '@/lib/fastapi-proxy';
import { getAuthContext } from '@/lib/auth-helpers';

type RouteParams = { params: Promise<{ id: string }> };

export async function GET(request: Request, { params }: RouteParams) {
  if (isOssMode()) {
    try {
      const { id } = await params;
      const me = await getAuthContext(request);
      if (!me) return ApiErrors.unauthorized();
      const repo = await createAgentRunRepository();
      const run = await repo.getById(id, me.org_id, me.project_id);
      if (!run) return ApiErrors.notFound('Agent run not found');
      return apiSuccess({ ...run, agent_name: null, tool_audit_trail: [], continuity_debug: null });
    } catch (error) { return handleApiError(error); }
  }
  const { id } = await params;
const _r = await proxyToFastapi(request, `/api/v2/agent-runs/${id}`);
  if (!_r.ok) return _r;
  if (_r.status === 204) return apiSuccess({ ok: true });
  return apiSuccess(await _r.json())
}

export async function PATCH(request: Request, { params }: RouteParams) {
  if (isOssMode()) {
    try {
      const { id } = await params;
      const me = await getAuthContext(request);
      if (!me) return ApiErrors.unauthorized();
      let body: unknown;
      try { body = await request.json(); } catch { body = {}; }
      const b = (body as Record<string, unknown>) ?? {};
      const { getDb } = await import('@sprintable/storage-pglite');
      const db = await getDb();
      const sets: string[] = [];
      const vals: unknown[] = [];
      const allowed = ['status','result_summary','error_message','started_at','finished_at','duration_ms','input_tokens','output_tokens'] as const;
      for (const k of allowed) {
        if (k in b) { sets.push(`${k} = $${sets.length + 1}`); vals.push(b[k] ?? null); }
      }
      if (sets.length) await db.query(`UPDATE agent_runs SET ${sets.join(', ')} WHERE id = $${sets.length + 1} AND org_id = $${sets.length + 2}`, [...vals, id, me.org_id]);
      const run = (await db.query('SELECT * FROM agent_runs WHERE id = $1', [id])).rows[0];
      if (!run) return ApiErrors.notFound('Agent run not found');
      return apiSuccess(run);
    } catch (error) { return handleApiError(error); }
  }
  const { id } = await params;
const _r = await proxyToFastapi(request, `/api/v2/agent-runs/${id}`);
  if (!_r.ok) return _r;
  if (_r.status === 204) return apiSuccess({ ok: true });
  return apiSuccess(await _r.json())
}
