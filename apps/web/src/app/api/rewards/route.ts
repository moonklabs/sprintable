import { parseBody, createRewardSchema } from '@sprintable/shared';
import { RewardsService } from '@/services/rewards';
import { handleApiError } from '@/lib/api-error';
import { getAuthContext } from '@/lib/auth-helpers';
import { apiSuccess, ApiErrors } from '@/lib/api-response';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const supabase: any = undefined;

export async function GET(request: Request) {
  try {
    const me = await getAuthContext(request);
    if (!me) return ApiErrors.unauthorized();
    if (me.rateLimitExceeded) return ApiErrors.tooManyRequests(me.rateLimitRemaining, me.rateLimitResetAt);
    const dbClient = me.type === 'agent' ? (await (await import('@/lib/supabase/admin')).createSupabaseAdminClient()) : supabase;
    const { searchParams } = new URL(request.url);
    // AC1: agent 요청 시 me.project_id 강제 — cross-project 조회 차단
    const projectId = me.type === 'agent' ? me.project_id : searchParams.get('project_id');
    if (!projectId) return ApiErrors.badRequest('project_id required');
    const service = new RewardsService(dbClient);
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
    // AC2: agent 요청 시 admin scope 필요 (requireOrgAdmin은 OAuth 전용이므로 scope 체크로 대체)
    if (me.type === 'agent' && !me.scope?.includes('admin')) {
      return ApiErrors.insufficientScope('admin');
    }
    const dbClient = me.type === 'agent' ? (await (await import('@/lib/supabase/admin')).createSupabaseAdminClient()) : supabase;
    const parsed = await parseBody(request, createRewardSchema); if (!parsed.success) return parsed.response; const body = parsed.data;
    const service = new RewardsService(dbClient);
    const entry = await service.grant({
      org_id: me.org_id, project_id: me.project_id,
      member_id: body.member_id, amount: body.amount,
      reason: body.reason, granted_by: me.id,
      reference_type: body.reference_type, reference_id: body.reference_id,
    });
    return apiSuccess(entry, undefined, 201);
  } catch (err: unknown) { return handleApiError(err); }
}
