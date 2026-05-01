import { handleApiError } from '@/lib/api-error';
import { apiSuccess, ApiErrors } from '@/lib/api-response';
import { getAuthContext } from '@/lib/auth-helpers';

// GET /api/dashboard?member_id=X[&project_id=X]
export async function GET(request: Request) {
  try {
    const me = await getAuthContext(request);
    if (!me) return ApiErrors.unauthorized();
    if (me.rateLimitExceeded) return ApiErrors.tooManyRequests(me.rateLimitRemaining, me.rateLimitResetAt);

    const { searchParams } = new URL(request.url);
    const memberId = searchParams.get('member_id');
    if (!memberId) return ApiErrors.badRequest('member_id required');

    return apiSuccess({
      my_stories: [],
      assigned_stories: [],
      my_tasks: [],
      open_memos: [],
    });
  } catch (err: unknown) {
    return handleApiError(err);
  }
}
