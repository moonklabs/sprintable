import { handleApiError } from '@/lib/api-error';
import { apiSuccess, ApiErrors } from '@/lib/api-response';
import { getAuthContext } from '@/lib/auth-helpers';
import { isOssMode } from '@/lib/storage/factory';
import { requireRole, ADMIN_ROLES } from '@/lib/role-guard';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const supabase: any = undefined;

type RouteParams = { params: Promise<{ id: string }> };

/** GET /api/api-keys/[id]/logs — 키별 사용 이력 (admin/owner only) */
export async function GET(request: Request, { params }: RouteParams) {
  if (isOssMode()) return apiSuccess([]);
  try {
    const { id } = await params;
    const me = await getAuthContext(request);
    if (!me) return ApiErrors.unauthorized();
    if (me.rateLimitExceeded) return ApiErrors.tooManyRequests(me.rateLimitRemaining, me.rateLimitResetAt);

    const denied = await requireRole(supabase, me.org_id, ADMIN_ROLES, 'Admin access required to view API key logs');
    if (denied) return denied;

    const { searchParams } = new URL(request.url);
    const limit = Math.min(Number(searchParams.get('limit') ?? '50'), 100);
    const cursor = searchParams.get('cursor') ?? undefined;

    const admin = (await (await import('@/lib/supabase/admin')).createSupabaseAdminClient());
    let query = admin
      .from('api_key_logs')
      .select('id, api_key_id, endpoint, ip_address, status_code, created_at')
      .eq('api_key_id', id)
      .eq('org_id', me.org_id)
      .order('created_at', { ascending: false })
      .limit(limit);

    if (cursor) query = query.lt('created_at', cursor);

    const { data, error } = await query;
    if (error) throw error;
    return apiSuccess(data ?? []);
  } catch (err: unknown) { return handleApiError(err); }
}
