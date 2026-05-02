import { handleApiError } from '@/lib/api-error';
import { apiSuccess, ApiErrors } from '@/lib/api-response';
import { getAuthContext } from '@/lib/auth-helpers';
import { isOssMode } from '@/lib/storage/factory';
import { proxyToFastapi } from '@/lib/fastapi-proxy';

// GET /api/retro-sessions?project_id=X
export async function GET(request: Request) {
  try {
    const me = await getAuthContext(request);
    if (!me) return ApiErrors.unauthorized();
    if (me.rateLimitExceeded) return ApiErrors.tooManyRequests(me.rateLimitRemaining, me.rateLimitResetAt);

    if (isOssMode()) {
      const { apiSuccess } = await import('@/lib/api-response');
      const { listOssRetroSessions } = await import('@/lib/oss-retro');
      const { searchParams } = new URL(request.url);
      const projectId = searchParams.get('project_id');
      if (!projectId) return ApiErrors.badRequest('project_id required');
      return apiSuccess(await listOssRetroSessions(projectId));
    }

const _r = await proxyToFastapi(request, '/api/v2/retros');
    if (!_r.ok) return _r;
    if (_r.status === 204) return apiSuccess({ ok: true });
    return apiSuccess(await _r.json())
  } catch (err: unknown) {
    return handleApiError(err);
  }
}

// POST /api/retro-sessions
export async function POST(request: Request) {
  try {
    const me = await getAuthContext(request);
    if (!me) return ApiErrors.unauthorized();
    if (me.rateLimitExceeded) return ApiErrors.tooManyRequests(me.rateLimitRemaining, me.rateLimitResetAt);

    if (isOssMode()) {
      const { apiSuccess } = await import('@/lib/api-response');
      const { createOssRetroSession } = await import('@/lib/oss-retro');
      const body = await request.json() as {
        project_id?: string; org_id?: string; title?: string;
        sprint_id?: string | null; created_by?: string;
      };
      if (!body.project_id) return ApiErrors.badRequest('project_id required');
      if (!body.org_id) return ApiErrors.badRequest('org_id required');
      if (!body.title) return ApiErrors.badRequest('title required');
      if (!body.created_by) return ApiErrors.badRequest('created_by required');
      const data = await createOssRetroSession({ org_id: body.org_id, project_id: body.project_id, title: body.title, sprint_id: body.sprint_id ?? null, created_by: body.created_by });
      return apiSuccess(data, undefined, 201);
    }

const _r = await proxyToFastapi(request, '/api/v2/retros');
    if (!_r.ok) return _r;
    if (_r.status === 204) return apiSuccess({ ok: true });
    return apiSuccess(await _r.json())
  } catch (err: unknown) {
    return handleApiError(err);
  }
}
