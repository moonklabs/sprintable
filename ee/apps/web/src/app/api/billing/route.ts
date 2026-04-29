import { createSupabaseServerClient } from '@/lib/supabase/server';
import { handleApiError } from '@/lib/api-error';
import { apiSuccess, ApiErrors } from '@/lib/api-response';
import { getMyTeamMember } from '@/lib/auth-helpers';
import { getPaymentAdapter } from '@/lib/payment/factory';

/** admin 여부 확인 (soft — 에러 안 던짐) */
async function isOrgAdmin(supabase: Awaited<ReturnType<typeof createSupabaseServerClient>>, orgId: string): Promise<boolean> {
  const { data } = await supabase
    .from('org_members')
    .select('role')
    .eq('org_id', orgId)
    .eq('user_id', (await supabase.auth.getUser()).data.user?.id ?? '')
    .single();
  return data?.role === 'admin' || data?.role === 'owner';
}

interface PaddleTransaction {
  id: string;
  status: string;
  created_at: string;
  billed_at: string | null;
  details: {
    totals: { grand_total: string; currency_code: string };
  };
  invoice_url?: string;
}

async function fetchPaddleInvoices(providerSubId: string, apiKey: string, sandbox: boolean): Promise<PaddleTransaction[]> {
  const base = sandbox ? 'https://sandbox-api.paddle.com' : 'https://api.paddle.com';
  const res = await fetch(`${base}/transactions?subscription_id=${providerSubId}&per_page=20`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!res.ok) return [];
  const json = await res.json() as { data: PaddleTransaction[] };
  return json.data ?? [];
}

/**
 * GET /api/billing
 * AC1: 현재 플랜, 다음 결제일, 결제 수단
 * AC2: 인보이스 목록
 * AC7: Grandfathering 표시
 */
export async function GET() {
  try {
    const supabase = await createSupabaseServerClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return ApiErrors.unauthorized();

    const me = await getMyTeamMember(supabase, user);
    if (!me) return ApiErrors.forbidden();

    // 구독 조회
    const { data: sub } = await supabase
      .from('subscriptions')
      .select('tier_id, status, current_period_end, payment_provider, provider_subscription_id, offering_snapshot_id')
      .eq('org_id', me.org_id)
      .maybeSingle();

    // 현재 tier
    const { data: tier } = sub?.tier_id
      ? await supabase.from('plan_tiers').select('id, name, price_monthly, price_yearly').eq('id', sub.tier_id).single()
      : { data: null };

    // AC7: grandfathering 여부
    let grandfathered = false;
    let snapshotFeatures: Record<string, unknown> | null = null;
    if (sub?.offering_snapshot_id) {
      const { data: snap } = await supabase
        .from('plan_offering_snapshots')
        .select('features, version')
        .eq('id', sub.offering_snapshot_id)
        .single();
      if (snap) {
        grandfathered = true;
        snapshotFeatures = snap.features as Record<string, unknown>;
      }
    }

    // AC2: 인보이스 목록 (Paddle API)
    let invoices: PaddleTransaction[] = [];
    if (sub?.provider_subscription_id && sub.payment_provider === 'paddle') {
      const apiKey = process.env.PADDLE_API_KEY;
      if (apiKey) {
        const sandbox = process.env.PAYMENT_SANDBOX === 'true';
        invoices = await fetchPaddleInvoices(sub.provider_subscription_id, apiKey, sandbox);
      }
    }

    // AC4: 결제 수단 변경 URL (admin only — non-admin 우회 방지)
    let paymentMethodUrl: string | null = null;
    const admin = await isOrgAdmin(supabase, me.org_id);
    if (admin && sub?.provider_subscription_id && sub.payment_provider === 'paddle') {
      try {
        const adapter = getPaymentAdapter('paddle');
        const portal = await adapter.getPortalUrl(sub.provider_subscription_id);
        paymentMethodUrl = portal.portalUrl;
      } catch { /* ignore */ }
    }

    return apiSuccess({
      subscription: sub,
      tier,
      grandfathered,
      snapshotFeatures,
      invoices: invoices.map(tx => ({
        id: tx.id,
        status: tx.status,
        billedAt: tx.billed_at ?? tx.created_at,
        amount: tx.details.totals.grand_total,
        currency: tx.details.totals.currency_code,
        invoiceUrl: tx.invoice_url ?? null,
      })),
      paymentMethodUrl,
    });
  } catch (err: unknown) { return handleApiError(err); }
}
