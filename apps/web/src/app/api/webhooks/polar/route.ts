import { validateEvent, WebhookVerificationError } from '@polar-sh/sdk/webhooks';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { isOssMode } from '@/lib/storage/factory';
import { NextResponse } from 'next/server';

// product_id → tier mapping (sandbox product IDs from E-POLAR:S1)
const PRODUCT_TIER: Record<string, string> = {
  '200c2c3c-1235-41e1-a259-1440200b4a93': 'team', // team monthly
  'e79b7587-6261-4384-abdb-f3fd13612f06': 'team', // team yearly
  '9e3c0067-7d28-4314-abe8-c59929eedf30': 'pro',  // pro monthly
  '39462386-91b7-4864-9cc2-eecc8cfc2307': 'pro',  // pro yearly
  'eaf0bf45-73ef-4e6a-a41a-e946b7e61362': 'free', // free
};

const BILLING_CYCLE: Record<string, string> = {
  '200c2c3c-1235-41e1-a259-1440200b4a93': 'monthly',
  'e79b7587-6261-4384-abdb-f3fd13612f06': 'yearly',
  '9e3c0067-7d28-4314-abe8-c59929eedf30': 'monthly',
  '39462386-91b7-4864-9cc2-eecc8cfc2307': 'yearly',
  'eaf0bf45-73ef-4e6a-a41a-e946b7e61362': 'monthly',
};

export async function POST(request: Request) {
  if (isOssMode()) return NextResponse.json({ ok: false }, { status: 501 });

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
      // Only process succeeded checkouts (Polar's "completed" state)
      if (event.data.status !== 'succeeded') break;
      const checkout = event.data;
      const orgId = checkout.metadata?.['org_id'] as string | undefined;
      if (!orgId || !checkout.customerId) break;

      const productId = checkout.productId ?? '';
      const tier = PRODUCT_TIER[productId] ?? 'free';
      const billingCycle = BILLING_CYCLE[productId] ?? null;

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
      // Unhandled event types — return 200 to prevent Polar retries
      break;
  }

  return NextResponse.json({ ok: true });
}
