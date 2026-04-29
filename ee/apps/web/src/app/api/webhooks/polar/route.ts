import { validateEvent, WebhookVerificationError } from '@polar-sh/sdk/webhooks';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { NextResponse } from 'next/server';
import { POLAR_PRODUCT_TIER, POLAR_PRODUCT_BILLING_CYCLE } from '@/lib/polar-products';

export async function POST(request: Request) {
  const rawBody = await request.text();
  const headers: Record<string, string> = {};
  request.headers.forEach((v, k) => { headers[k] = v; });

  const secret = process.env['POLAR_WEBHOOK_SECRET'];
  if (!secret) {
    console.error('POLAR_WEBHOOK_SECRET not set');
    return NextResponse.json({ ok: false }, { status: 500 });
  }

  let event;
  try {
    event = validateEvent(rawBody, headers, secret);
  } catch (err) {
    if (err instanceof WebhookVerificationError) {
      return NextResponse.json({ ok: false, error: 'Invalid signature' }, { status: 403 });
    }
    throw err;
  }

  const supabase = createSupabaseAdminClient();

  switch (event.type) {
    case 'checkout.updated': {
      if (event.data.status !== 'succeeded') break;
      const checkout = event.data;
      const orgId = checkout.metadata?.['org_id'] as string | undefined;
      if (!orgId || !checkout.customerId) break;

      const productId = checkout.productId ?? '';
      const tier = POLAR_PRODUCT_TIER[productId] ?? 'free';
      const billingCycle = POLAR_PRODUCT_BILLING_CYCLE[productId] ?? null;

      await supabase.from('org_subscriptions').upsert({
        org_id: orgId,
        polar_customer_id: checkout.customerId,
        polar_subscription_id: checkout.subscriptionId ?? null,
        tier,
        billing_cycle: billingCycle,
        status: 'active',
        updated_at: new Date().toISOString(),
      }, { onConflict: 'org_id' });
      break;
    }

    case 'subscription.active': {
      const sub = event.data;
      await supabase.from('org_subscriptions')
        .update({
          status: 'active',
          polar_subscription_id: sub.id,
          current_period_start: sub.currentPeriodStart.toISOString(),
          current_period_end: sub.currentPeriodEnd.toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq('polar_customer_id', sub.customerId);
      break;
    }

    case 'subscription.canceled': {
      await supabase.from('org_subscriptions')
        .update({ status: 'canceled', updated_at: new Date().toISOString() })
        .eq('polar_subscription_id', event.data.id);
      break;
    }

    case 'subscription.past_due': {
      await supabase.from('org_subscriptions')
        .update({ status: 'past_due', updated_at: new Date().toISOString() })
        .eq('polar_subscription_id', event.data.id);
      break;
    }

    case 'subscription.revoked': {
      await supabase.from('org_subscriptions')
        .update({ status: 'expired', tier: 'free', updated_at: new Date().toISOString() })
        .eq('polar_subscription_id', event.data.id);
      break;
    }

    case 'order.created': {
      const order = event.data;
      if (!order.subscription) break;
      await supabase.from('org_subscriptions')
        .update({
          current_period_start: order.createdAt.toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq('polar_subscription_id', order.subscription.id);
      break;
    }

    default:
      break;
  }

  return NextResponse.json({ ok: true });
}
