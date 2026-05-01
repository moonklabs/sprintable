import { handleApiError } from '@/lib/api-error';
import { apiSuccess, ApiErrors } from '@/lib/api-response';
import { getAuthContext } from '@/lib/auth-helpers';

// GET /api/project-settings?project_id=
export async function GET(request: Request) {
  try {
    const me = await getAuthContext(request);
    if (!me) return ApiErrors.unauthorized();
    if (me.rateLimitExceeded) return ApiErrors.tooManyRequests(me.rateLimitRemaining, me.rateLimitResetAt);

    const { searchParams } = new URL(request.url);
    const projectId = searchParams.get('project_id') ?? me.project_id;
    return apiSuccess({ project_id: projectId, standup_deadline: '09:00' });
  } catch (err: unknown) { return handleApiError(err); }
}

// PATCH /api/project-settings
export async function PATCH(request: Request) {
  try {
    const me = await getAuthContext(request);
    if (!me) return ApiErrors.unauthorized();
    if (me.rateLimitExceeded) return ApiErrors.tooManyRequests(me.rateLimitRemaining, me.rateLimitResetAt);

    const body = await request.json() as { project_id?: string; standup_deadline?: string };
    const projectId = body.project_id ?? me.project_id;
    return apiSuccess({ project_id: projectId, standup_deadline: body.standup_deadline ?? '09:00' });
  } catch (err: unknown) { return handleApiError(err); }
}
