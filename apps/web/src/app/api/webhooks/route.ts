import { handleApiError } from '@/lib/api-error';
import { getMyTeamMember } from '@/lib/auth-helpers';
import { requireOrgAdmin } from '@/lib/admin-check';
import { apiSuccess, apiError, ApiErrors } from '@/lib/api-response';
import { isOssMode } from '@/lib/storage/factory';

export async function GET(request: Request) {
  if (isOssMode()) return apiError('NOT_AVAILABLE', 'Not available in OSS mode.', 503);
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db: any = null;
    const { data: { user } } = await db.auth.getUser();
    if (!user) return ApiErrors.unauthorized();
    const me = await getMyTeamMember(db, user);
    if (!me) return ApiErrors.forbidden();
    const { searchParams } = new URL(request.url);
    const targetId = searchParams.get('member_id') ?? me.id;
    if (targetId !== me.id) await requireOrgAdmin(db, me.org_id);
    const { data, error } = await db.from('webhook_configs').select('*').eq('member_id', targetId);
    if (error) throw error;
    return apiSuccess(data);
  } catch (err: unknown) { return handleApiError(err); }
}

// Deprecated: use PUT /api/webhooks/config instead (supports project_id scoping)
export async function PUT() {
  return apiError('GONE', 'Use PUT /api/webhooks/config instead.', 410);
}
