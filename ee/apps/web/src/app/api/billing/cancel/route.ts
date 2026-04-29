import { createSupabaseServerClient } from '@/lib/supabase/server';
import { handleApiError } from '@/lib/api-error';
import { apiSuccess, ApiErrors } from '@/lib/api-response';
import { getMyTeamMember } from '@/lib/auth-helpers';
import { requireOrgAdmin } from '@/lib/admin-check';
import { getPaymentAdapter } from '@/lib/payment/factory';
import { SubscriptionService } from '@/services/subscription';
import { z } from 'zod';
import { parseBody } from '@sprintable/shared';

const cancelSchema = z.object({
  immediately: z.boolean().optional().default(false),
});

/**
 * POST /api/billing/cancel
 * AC5: 구독 취소 (즉시 vs 기간 만료 후)
 */
export async function POST(request: Request) {
  try {
    const supabase = await createSupabaseServerClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return ApiErrors.unauthorized();

    const me = await getMyTeamMember(supabase, user);
    if (!me) return ApiErrors.forbidden();
    await requireOrgAdmin(supabase, me.org_id);

    const parsed = await parseBody(request, cancelSchema);
    if (!parsed.success) return parsed.response;

    const { data: sub } = await supabase
      .from('subscriptions')
      .select('provider_subscription_id, payment_provider, status')
      .eq('org_id', me.org_id)
      .single();

    if (!sub?.provider_subscription_id) return ApiErrors.badRequest('No active subscription');

    // PG 취소 요청 (AC5: 즉시 vs 기간만료 분기)
    const adapter = getPaymentAdapter(sub.payment_provider as 'paddle' | 'toss');
    await adapter.cancelSubscription(sub.provider_subscription_id, parsed.data.immediately);

    // DB 업데이트
    const service = new SubscriptionService(supabase);
    const result = await service.cancelSubscription(me.org_id);

    // 즉시 취소 시 grace period 없이 바로 Free로
    if (parsed.data.immediately) {
      await service.downgradeToFree(me.org_id);
    }

    return apiSuccess(result);
  } catch (err: unknown) { return handleApiError(err); }
}
