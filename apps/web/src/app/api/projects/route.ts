import { handleApiError } from '@/lib/api-error';
import { apiSuccess, apiError, ApiErrors } from '@/lib/api-response';
import { isOssMode, createProjectRepository, createTeamMemberRepository } from '@/lib/storage/factory';
import { getAuthContext } from '@/lib/auth-helpers';
import { proxyToFastapi } from '@/lib/fastapi-proxy';

/** GET — 조직 프로젝트 목록 */
export async function GET(request: Request) {
  try {
    if (isOssMode()) {
      const { getDb } = await import('@sprintable/storage-pglite');
      const db = await getDb();
      const projects = (await db.query('SELECT id, name, org_id FROM projects WHERE deleted_at IS NULL ORDER BY created_at ASC')).rows as Array<{ id: string; name: string; org_id: string }>;
      return apiSuccess(projects.map((p) => ({ id: p.id, name: p.name, description: null, org_id: p.org_id })));
    }
const _r = await proxyToFastapi(request, '/api/v2/projects');
    if (!_r.ok) return _r;
    if (_r.status === 204) return apiSuccess({ ok: true });
    return apiSuccess(await _r.json())
  } catch (err: unknown) {
    return handleApiError(err);
  }
}

/** POST — 프로젝트 생성 */
export async function POST(request: Request) {
  try {
    if (isOssMode()) {
      const me = await getAuthContext(request);
      if (!me) return ApiErrors.unauthorized();

      let body: unknown;
      try { body = await request.json(); } catch { return apiError('BAD_REQUEST', 'Invalid JSON body', 400); }
      const { name, description } = (body as Record<string, unknown>) ?? {};
      if (typeof name !== 'string' || !name.trim()) return apiError('VALIDATION_ERROR', 'name is required', 400);

      const projectRepo = await createProjectRepository();
      const project = await projectRepo.create({
        org_id: me.org_id,
        name: name.trim(),
        description: typeof description === 'string' ? description || null : null,
        created_by: me.id,
      });

      const memberRepo = await createTeamMemberRepository();
      await memberRepo.create({
        org_id: me.org_id,
        project_id: project.id,
        name: 'Admin',
        role: 'owner',
        type: 'human',
        is_active: true,
      });

      return apiSuccess(project, undefined, 201);
    }
    const _r = await proxyToFastapi(request, '/api/v2/projects');
    if (!_r.ok) return _r;
    if (_r.status === 204) return apiSuccess({ ok: true });
    return apiSuccess(await _r.json());
  } catch (err: unknown) {
    return handleApiError(err);
  }
}
