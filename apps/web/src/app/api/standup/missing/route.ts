import { handleApiError } from '@/lib/api-error';
import { apiSuccess, ApiErrors } from '@/lib/api-response';
import { getAuthContext } from '@/lib/auth-helpers';
import { isOssMode } from '@/lib/storage/factory';
import { getOssStandupMissing } from '@/lib/oss-standup';
import { StandupService } from '@/services/standup';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const supabase: any = undefined;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SupabaseClient = any;

// GET /api/standup/missing?project_id=X&date=YYYY-MM-DD
export async function GET(request: Request) {
  try {
    const me = await getAuthContext(request);
    if (!me) return ApiErrors.unauthorized();
    if (me.rateLimitExceeded) return ApiErrors.tooManyRequests(me.rateLimitRemaining, me.rateLimitResetAt);

    const { searchParams } = new URL(request.url);
    const projectId = searchParams.get('project_id');
    const date = searchParams.get('date');
    if (!projectId) return ApiErrors.badRequest('project_id required');
    if (!date) return ApiErrors.badRequest('date required');

    if (isOssMode()) {
      return apiSuccess(await getOssStandupMissing(projectId, date));
    }

    const dbClient: SupabaseClient = me.type === 'agent' ? (await (await import('@/lib/supabase/admin')).createSupabaseAdminClient()) : supabase;
    const service = new StandupService(dbClient);
    const data = await service.getMissing(projectId, date);
    return apiSuccess(data);
  } catch (err: unknown) {
    return handleApiError(err);
  }
}
