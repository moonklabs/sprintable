
import { createAdminClient } from '@/lib/db/admin';
import { handleApiError } from '@/lib/api-error';
import { apiSuccess, ApiErrors } from '@/lib/api-response';
import { getAuthContext } from '@/lib/auth-helpers';

type RouteParams = { params: Promise<{ id: string }> };

// GET /api/sprints/:id/velocity — sprint velocity + title + status
export async function GET(request: Request, { params }: RouteParams) {
  try {
    const { id } = await params;
    const me = await getAuthContext(request);
    if (!me) return ApiErrors.unauthorized();
    if (me.rateLimitExceeded) return ApiErrors.tooManyRequests(me.rateLimitRemaining, me.rateLimitResetAt);
    const dbClient: any = me.type === 'agent' ? createAdminClient() : undefined;

    const { data, error } = await dbClient
      .from('sprints')
      .select('velocity, title, status')
      .eq('id', id)
      .single();

    if (error) {
      if (error.code === 'PGRST116') return ApiErrors.notFound('Sprint not found');
      throw error;
    }
    return apiSuccess(data);
  } catch (err: unknown) { return handleApiError(err); }
}
