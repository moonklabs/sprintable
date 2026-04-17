import { createSupabaseServerClient } from '@/lib/supabase/server';
import { handleApiError } from '@/lib/api-error';
import { apiSuccess, ApiErrors } from '@/lib/api-response';
import { getMyTeamMember } from '@/lib/auth-helpers';

/** GET /api/usage — AC5: 조직의 현재 월 usage meters */
export async function GET() {
  try {
    const supabase = await createSupabaseServerClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return ApiErrors.unauthorized();

    const me = await getMyTeamMember(supabase, user);
    if (!me) return ApiErrors.forbidden();

    const now = new Date();
    const periodStart = new Date(now.getFullYear(), now.getMonth(), 1);

    const { data: meters } = await supabase
      .from('usage_meters')
      .select('meter_type, current_value, limit_value, period_start, period_end')
      .eq('org_id', me.org_id)
      .gte('period_start', periodStart.toISOString())
      .order('meter_type');

    return apiSuccess(meters ?? []);
  } catch (err: unknown) { return handleApiError(err); }
}
