import { RewardsService } from '@/services/rewards';
import { handleApiError } from '@/lib/api-error';
import { apiSuccess, ApiErrors } from '@/lib/api-response';
import { getAuthContext } from '@/lib/auth-helpers';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const supabase: any = undefined;

/** GET /api/rewards/leaderboard?project_id=X&period=daily|weekly|monthly|all&limit=N&cursor=X */
export async function GET(request: Request) {
  try {
    const me = await getAuthContext(request);
    if (!me) return ApiErrors.unauthorized();
    if (me.rateLimitExceeded) return ApiErrors.tooManyRequests(me.rateLimitRemaining, me.rateLimitResetAt);

    const { searchParams } = new URL(request.url);
    const projectId = me.type === 'agent' ? me.project_id : (searchParams.get('project_id') ?? me.project_id);
    if (!projectId) return ApiErrors.badRequest('project_id required');

    const period = (searchParams.get('period') ?? 'all') as 'daily' | 'weekly' | 'monthly' | 'all';
    if (!['daily', 'weekly', 'monthly', 'all'].includes(period)) {
      return ApiErrors.badRequest('period must be one of: daily, weekly, monthly, all');
    }

    const limit = Math.min(Number(searchParams.get('limit') ?? '50'), 100);
    const cursor = searchParams.get('cursor') ?? undefined;

    const dbClient = me.type === 'agent' ? (await (await import('@/lib/supabase/admin')).createSupabaseAdminClient()) : supabase;
    const service = new RewardsService(dbClient);
    const data = await service.getLeaderboardByPeriod(projectId, period, limit, cursor);
    return apiSuccess(data);
  } catch (err: unknown) { return handleApiError(err); }
}
