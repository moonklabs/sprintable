import { handleApiError } from '@/lib/api-error';
import { apiSuccess, ApiErrors, apiError } from '@/lib/api-response';
import { isOssMode } from '@/lib/storage/factory';
import { getAuthContext } from '@/lib/auth-helpers';
import { proxyToFastapi } from '@/lib/fastapi-proxy';

export async function GET(request: Request) {
  try {
    if (isOssMode()) {
      const me = await getAuthContext(request);
      if (!me) return ApiErrors.unauthorized();
      const { getDb } = await import('@sprintable/storage-pglite');
      const db = await getDb();
      const personas = (await db.query(
        'SELECT * FROM agent_personas WHERE project_id = $1 ORDER BY created_at ASC',
        [me.project_id]
      )).rows;
      return apiSuccess(personas);
    }
    const _r = await proxyToFastapi(request, '/api/v2/agent-personas');
    if (!_r.ok) return _r;
    return apiSuccess(await _r.json());
  } catch (err: unknown) { return handleApiError(err); }
}

export async function POST(request: Request) {
  try {
    if (isOssMode()) {
      const me = await getAuthContext(request);
      if (!me) return ApiErrors.unauthorized();
      let body: unknown;
      try { body = await request.json(); } catch { return apiError('BAD_REQUEST', 'Invalid JSON', 400); }
      const b = (body as Record<string, unknown>) ?? {};
      if (typeof b.name !== 'string' || !b.name.trim()) return apiError('VALIDATION_ERROR', 'name is required', 400);
      if (typeof b.agent_id !== 'string' || !b.agent_id.trim()) return apiError('VALIDATION_ERROR', 'agent_id is required', 400);

      const { getDb } = await import('@sprintable/storage-pglite');
      const { randomUUID } = await import('node:crypto');
      const db = await getDb();
      const id = randomUUID();
      const now = new Date().toISOString();
      const slug = (b.name as string).trim().toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
      await db.query(
        'INSERT INTO agent_personas (id, org_id, project_id, agent_id, name, slug, description, system_prompt, style_prompt, model, config, is_builtin, is_default, created_by, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$15)',
        [id, me.org_id, me.project_id, b.agent_id, (b.name as string).trim(), slug, b.description ?? null, b.system_prompt ?? '', b.style_prompt ?? null, b.model ?? null, JSON.stringify(b.config ?? {}), 0, 0, me.id, now]
      );
      const persona = (await db.query('SELECT * FROM agent_personas WHERE id = $1', [id])).rows[0];
      return apiSuccess(persona, undefined, 201);
    }
    const _r = await proxyToFastapi(request, '/api/v2/agent-personas');
    if (!_r.ok) return _r;
    return apiSuccess(await _r.json());
  } catch (err: unknown) { return handleApiError(err); }
}
