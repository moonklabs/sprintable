import { createSupabaseServerClient } from '@/lib/supabase/server';
import { handleApiError } from '@/lib/api-error';
import { apiSuccess, ApiErrors } from '@/lib/api-response';
import { getMyTeamMember } from '@/lib/auth-helpers';
import { requireOrgAdmin } from '@/lib/admin-check';
import { getPaymentAdapter } from '@/lib/payment/factory';

/** POST /api/subscription/portal — AC7: Paddle customer portal URL */
export async function POST() {
  try {
    const supabase = await createSupabaseServerClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return ApiErrors.unauthorized();

    const me = await getMyTeamMember(supabase, user);
    if (!me) return ApiErrors.forbidden();
    await requireOrgAdmin(supabase, me.org_id);

    const { data: sub } = await supabase
      .from('subscriptions')
      .select('provider_subscription_id, payment_provider')
      .eq('org_id', me.org_id)
      .single();

    if (!sub?.provider_subscription_id) {
      return ApiErrors.badRequest('No active paid subscription');
    }

    const adapter = getPaymentAdapter(sub.payment_provider as 'paddle' | 'toss');
    const result = await adapter.getPortalUrl(sub.provider_subscription_id);
    return apiSuccess(result);
  } catch (err: unknown) { return handleApiError(err); }
}
