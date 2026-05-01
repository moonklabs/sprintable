import { handleApiError } from '@/lib/api-error';
import { apiSuccess, ApiErrors } from '@/lib/api-response';
import { getAuthContext } from '@/lib/auth-helpers';
import { isOssMode } from '@/lib/storage/factory';
import { requireRole, ADMIN_ROLES } from '@/lib/role-guard';
import { AuditLogService } from '@/services/audit-log.service';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const supabase: any = undefined;

// GET /api/audit-logs?limit=50&cursor=<iso_timestamp>
export async function GET(request: Request) {
  if (isOssMode()) return ApiErrors.notFound('Not supported in OSS mode');
  try {
    const me = await getAuthContext(request);
    if (!me) return ApiErrors.unauthorized();
    if (me.rateLimitExceeded) return ApiErrors.tooManyRequests(me.rateLimitRemaining, me.rateLimitResetAt);

    const denied = await requireRole(supabase, me.org_id, ADMIN_ROLES, 'Admin access required to view audit logs');
    if (denied) return denied;

    const { searchParams } = new URL(request.url);
    const limit = Math.min(Number(searchParams.get('limit') ?? '50'), 100);
    const cursor = searchParams.get('cursor') ?? undefined;

    const service = new AuditLogService((await (await import('@/lib/supabase/admin')).createSupabaseAdminClient()));
    const data = await service.list(me.org_id, limit, cursor);
    return apiSuccess(data);
  } catch (err: unknown) { return handleApiError(err); }
}
