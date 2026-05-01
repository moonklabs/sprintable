import { parseBody, createRewardSchema } from '@sprintable/shared';
import { RewardsService } from '@/services/rewards';
import { handleApiError } from '@/lib/api-error';
import { getAuthContext } from '@/lib/auth-helpers';
import { apiSuccess, ApiErrors } from '@/lib/api-response';

export async function GET(request: Request) {
  try {
    const me = await getAuthContext(request);
    if (!me) return ApiErrors.unauthorized();
    if (me.rateLimitExceeded) return ApiErrors.tooManyRequests(me.rateLimitRemaining, me.rateLimitResetAt);
    const { searchParams } = new URL(request.url);
    const projectId = me.type === 'agent' ? me.project_id : searchParams.get('project_id');
    if (!projectId) return ApiErrors.badRequest('project_id required');
    const service = new RewardsService(undefined);
    const type = searchParams.get('type');
    if (type === 'leaderboard') return apiSuccess(await service.getLeaderboard(projectId));
    const memberId = searchParams.get('member_id');
    if (memberId && searchParams.get('balance') === 'true') return apiSuccess(await service.getBalance(projectId, memberId));
    return apiSuccess(await service.getLedger(projectId, memberId ?? undefined));
  } catch (err: unknown) { return handleApiError(err); }
}

export async function POST(request: Request) {
  try {
    const me = await getAuthContext(request);
    if (!me) return ApiErrors.unauthorized();
    if (me.rateLimitExceeded) return ApiErrors.tooManyRequests(me.rateLimitRemaining, me.rateLimitResetAt);
    if (me.type === 'agent' && !me.scope?.includes('admin')) {
      return ApiErrors.insufficientScope('admin');
    }
    const parsed = await parseBody(request, createRewardSchema); if (!parsed.success) return parsed.response; const body = parsed.data;
    const service = new RewardsService(undefined);
    const entry = await service.grant({
      org_id: me.org_id, project_id: me.project_id,
      member_id: body.member_id, amount: body.amount,
      reason: body.reason, granted_by: me.id,
      reference_type: body.reference_type, reference_id: body.reference_id,
    });
    return apiSuccess(entry, undefined, 201);
  } catch (err: unknown) { return handleApiError(err); }
}
