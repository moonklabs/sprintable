import { z } from 'zod';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { handleApiError } from '@/lib/api-error';
import { apiSuccess, ApiErrors } from '@/lib/api-response';
import { getMyTeamMember } from '@/lib/auth-helpers';
import { requireOrgAdmin } from '@/lib/admin-check';
import { getPaymentAdapter } from '@/lib/payment/factory';
import { SubscriptionService } from '@/services/subscription';
import { parseBody } from '@sprintable/shared';

const checkoutSchema = z.object({
  priceId: z.string().min(1),
  successUrl: z.string().url(),
  cancelUrl: z.string().url(),
});

/**
 * POST /api/checkout
 * AC5: 체크아웃 URL 생성
 * AC8: Zod 검증
 * AC9: 환경변수 기반 PG 선택
 * AC10: sandbox 지원 (PAYMENT_SANDBOX env)
 */
export async function POST(request: Request) {
  try {
    const supabase = await createSupabaseServerClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return ApiErrors.unauthorized();

    const me = await getMyTeamMember(supabase, user);
    if (!me) return ApiErrors.forbidden();
    await requireOrgAdmin(supabase, me.org_id);

    const parsed = await parseBody(request, checkoutSchema);
    if (!parsed.success) return parsed.response;

    // AC5: priceId ↔ tierId 서버 사이드 검증 (권한 상승 방지)
    // price_tier_map에서 priceId로 매핑된 tierId 조회 → 클라이언트 tierId 무시
    const adapter = getPaymentAdapter();
    const { data: mapping } = await supabase
      .from('price_tier_map')
      .select('tier_id')
      .eq('provider', adapter.provider)
      .eq('price_id', parsed.data.priceId)
      .single();

    if (!mapping) {
      return ApiErrors.badRequest('Unknown priceId — not mapped to any tier');
    }

    const serverTierId = mapping.tier_id as string;

    const result = await adapter.createCheckout({
      orgId: me.org_id,
      tierId: serverTierId,  // 서버에서 매핑된 tier 사용 (클라이언트 tierId 무시)
      priceId: parsed.data.priceId,
      customerEmail: user.email ?? '',
      successUrl: parsed.data.successUrl,
      cancelUrl: parsed.data.cancelUrl,
    });

    const subscriptionService = new SubscriptionService(supabase);
    await subscriptionService.recordCheckoutSession({
      orgId: me.org_id,
      tierId: serverTierId,
      provider: adapter.provider,
      priceId: parsed.data.priceId,
      providerTransactionId: result.providerTransactionId,
      checkoutUrl: result.checkoutUrl,
    });

    return apiSuccess(result);
  } catch (err: unknown) { return handleApiError(err); }
}
