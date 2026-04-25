import { createSupabaseServerClient } from '@/lib/supabase/server';
import { handleApiError } from '@/lib/api-error';
import { apiSuccess, ApiErrors } from '@/lib/api-response';
import { getAuthContext } from '@/lib/auth-helpers';
import { isOssMode } from '@/lib/storage/factory';

/** GET /api/subscription/status — grace_until + status 조회 */
export async function GET(request: Request) {
  if (isOssMode()) return apiSuccess({ status: 'active', grace_until: null });
  try {
    const supabase = await createSupabaseServerClient();
    const me = await getAuthContext(supabase, request);
    if (!me) return ApiErrors.unauthorized();

    const { data } = await supabase
      .from('org_subscriptions')
      .select('status, tier, grace_until')
      .eq('org_id', me.org_id)
      .maybeSingle();

    return apiSuccess(data ?? { status: 'active', tier: 'free', grace_until: null });
  } catch (err: unknown) { return handleApiError(err); }
}
