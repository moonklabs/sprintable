import { handleApiError } from '@/lib/api-error';
import { apiSuccess, ApiErrors } from '@/lib/api-response';
import { getAuthContext } from '@/lib/auth-helpers';
import { createTeamMemberRepository } from '@/lib/storage/factory';

// GET /api/members?project_id=X
export async function GET(request: Request) {
  try {
    const me = await getAuthContext(request);
    if (!me) return ApiErrors.unauthorized();
    if (me.rateLimitExceeded) return ApiErrors.tooManyRequests(me.rateLimitRemaining, me.rateLimitResetAt);

    const { searchParams } = new URL(request.url);
    const projectId = searchParams.get('project_id');
    if (!projectId) return ApiErrors.badRequest('project_id required');

    const repo = await createTeamMemberRepository();
    const members = await repo.list({ org_id: me.org_id, project_id: projectId });
    const active = members.filter((m) => m.is_active);
    return apiSuccess(active);
  } catch (err: unknown) {
    return handleApiError(err);
  }
}
