/**
 * AC6/7: 구독 관리 서비스
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type {
  WebhookEvent,
  PaymentProvider,
  CheckoutLifecycleStatus,
  SubscriptionLifecycleStatus,
} from '@/lib/payment/types';

const FREE_TIER_ID = '00000000-0000-0000-0000-000000000a01';
const GRACE_PERIOD_DAYS = 7;

type SubscriptionRow = {
  org_id: string;
  tier_id: string | null;
  offering_snapshot_id: string | null;
  status: string;
  current_period_start: string | null;
  current_period_end: string | null;
  payment_provider: PaymentProvider | null;
  provider_subscription_id: string | null;
  canceled_at: string | null;
  grace_period_end: string | null;
  last_webhook_event_id: string | null;
  last_webhook_event_at: string | null;
};

type CheckoutSessionRow = {
  org_id: string;
  requested_tier_id: string | null;
  provider: PaymentProvider;
  price_id: string | null;
  provider_transaction_id: string;
  provider_subscription_id: string | null;
  status: CheckoutLifecycleStatus;
  checkout_url: string | null;
  last_webhook_event_id: string | null;
  last_webhook_event_at: string | null;
};

function addDaysIso(base: string | Date, days: number) {
  const date = new Date(base);
  date.setDate(date.getDate() + days);
  return date.toISOString();
}

function isUniqueViolation(error: unknown) {
  return Boolean(error && typeof error === 'object' && 'code' in error && (error as { code?: string }).code === '23505');
}

export class SubscriptionService {
  constructor(private readonly supabase: SupabaseClient) {}

  async recordCheckoutSession(input: {
    orgId: string;
    tierId: string;
    provider: PaymentProvider;
    priceId: string;
    providerTransactionId: string;
    checkoutUrl: string;
  }) {
    const { data, error } = await this.supabase
      .from('subscription_checkout_sessions')
      .upsert(
        {
          org_id: input.orgId,
          requested_tier_id: input.tierId,
          provider: input.provider,
          price_id: input.priceId,
          provider_transaction_id: input.providerTransactionId,
          status: 'pending',
          checkout_url: input.checkoutUrl,
        },
        { onConflict: 'provider,provider_transaction_id' },
      )
      .select()
      .single();

    if (error) throw error;
    return data;
  }

  /** 구독 활성화 — 웹훅 수신 후 호출 */
  async activateSubscription(
    orgId: string,
    tierId: string,
    provider: PaymentProvider,
    providerSubId: string | null,
    periodStart: string | null,
    periodEnd: string | null,
    options?: {
      status?: Extract<SubscriptionLifecycleStatus, 'active' | 'trialing'>;
      eventId?: string | null;
      occurredAt?: string | null;
    },
  ) {
    const existing = await this.getSubscriptionByOrg(orgId);
    const snapshotId = await this.resolveSnapshotId(tierId, existing);

    const { data, error } = await this.supabase
      .from('subscriptions')
      .upsert(
        {
          org_id: orgId,
          tier_id: tierId,
          offering_snapshot_id: snapshotId,
          status: options?.status ?? 'active',
          payment_provider: provider,
          provider_subscription_id: providerSubId,
          current_period_start: periodStart,
          current_period_end: periodEnd,
          canceled_at: null,
          grace_period_end: null,
          ...(options?.eventId ? { last_webhook_event_id: options.eventId } : {}),
          ...(options?.occurredAt ? { last_webhook_event_at: options.occurredAt } : {}),
        },
        { onConflict: 'org_id' },
      )
      .select()
      .single();

    if (error) throw error;
    return data;
  }

  /** AC7: 구독 취소 — canceled_at + grace_period_end 설정 */
  async cancelSubscription(orgId: string) {
    const now = new Date();
    const gracePeriodEnd = addDaysIso(now, GRACE_PERIOD_DAYS);

    const { data, error } = await this.supabase
      .from('subscriptions')
      .update({
        status: 'canceled',
        canceled_at: now.toISOString(),
        grace_period_end: gracePeriodEnd,
      })
      .eq('org_id', orgId)
      .select()
      .single();

    if (error) throw error;
    return data;
  }

  /** AC7: grace period 만료 후 Free 다운그레이드 */
  async downgradeToFree(orgId: string) {
    const snapshotId = await this.resolveSnapshotId(FREE_TIER_ID, null);

    const { data, error } = await this.supabase
      .from('subscriptions')
      .update({
        tier_id: FREE_TIER_ID,
        offering_snapshot_id: snapshotId,
        status: 'active',
        payment_provider: null,
        provider_subscription_id: null,
        canceled_at: null,
        grace_period_end: null,
      })
      .eq('org_id', orgId)
      .select()
      .single();

    if (error) throw error;
    return data;
  }

  private async getSubscriptionByOrg(orgId: string) {
    const { data, error } = await this.supabase
      .from('subscriptions')
      .select('org_id, tier_id, offering_snapshot_id, status, current_period_start, current_period_end, payment_provider, provider_subscription_id, canceled_at, grace_period_end, last_webhook_event_id, last_webhook_event_at')
      .eq('org_id', orgId)
      .maybeSingle();

    if (error) throw error;
    return (data as SubscriptionRow | null) ?? null;
  }

  private async getSubscriptionByProvider(provider: PaymentProvider, providerSubscriptionId: string) {
    const { data, error } = await this.supabase
      .from('subscriptions')
      .select('org_id, tier_id, offering_snapshot_id, status, current_period_start, current_period_end, payment_provider, provider_subscription_id, canceled_at, grace_period_end, last_webhook_event_id, last_webhook_event_at')
      .eq('payment_provider', provider)
      .eq('provider_subscription_id', providerSubscriptionId)
      .maybeSingle();

    if (error) throw error;
    return (data as SubscriptionRow | null) ?? null;
  }

  private async getCheckoutSessionByTransaction(provider: PaymentProvider, providerTransactionId: string) {
    const { data, error } = await this.supabase
      .from('subscription_checkout_sessions')
      .select('org_id, requested_tier_id, provider, price_id, provider_transaction_id, provider_subscription_id, status, checkout_url, last_webhook_event_id, last_webhook_event_at')
      .eq('provider', provider)
      .eq('provider_transaction_id', providerTransactionId)
      .maybeSingle();

    if (error) throw error;
    return (data as CheckoutSessionRow | null) ?? null;
  }

  private async getCheckoutSessionBySubscription(provider: PaymentProvider, providerSubscriptionId: string) {
    const { data, error } = await this.supabase
      .from('subscription_checkout_sessions')
      .select('org_id, requested_tier_id, provider, price_id, provider_transaction_id, provider_subscription_id, status, checkout_url, last_webhook_event_id, last_webhook_event_at')
      .eq('provider', provider)
      .eq('provider_subscription_id', providerSubscriptionId)
      .maybeSingle();

    if (error) throw error;
    return (data as CheckoutSessionRow | null) ?? null;
  }

  private async isKnownTier(tierId: string) {
    const { data, error } = await this.supabase
      .from('plan_tiers')
      .select('id')
      .eq('id', tierId)
      .maybeSingle();

    if (error) throw error;
    return Boolean(data?.id);
  }

  private async getActiveSnapshotId(tierId: string) {
    const { data, error } = await this.supabase
      .from('plan_offering_snapshots')
      .select('id')
      .eq('tier_id', tierId)
      .is('effective_until', null)
      .order('version', { ascending: false })
      .maybeSingle();

    if (error) throw error;
    return (data as { id?: string } | null)?.id ?? null;
  }

  private async resolveSnapshotId(tierId: string, existing: SubscriptionRow | null) {
    if (existing?.tier_id === tierId && existing.offering_snapshot_id) return existing.offering_snapshot_id;
    const snapshotId = await this.getActiveSnapshotId(tierId);
    if (!snapshotId) throw new Error(`No active offering snapshot for tier ${tierId}`);
    return snapshotId;
  }

  private async resolveContext(event: WebhookEvent, provider: PaymentProvider) {
    const subscriptionByProvider = event.providerSubscriptionId
      ? await this.getSubscriptionByProvider(provider, event.providerSubscriptionId)
      : null;
    const checkoutByTransaction = event.providerTransactionId
      ? await this.getCheckoutSessionByTransaction(provider, event.providerTransactionId)
      : null;
    const checkoutBySubscription = event.providerSubscriptionId
      ? await this.getCheckoutSessionBySubscription(provider, event.providerSubscriptionId)
      : null;

    let orgId = event.orgId ?? subscriptionByProvider?.org_id ?? checkoutByTransaction?.org_id ?? checkoutBySubscription?.org_id ?? null;
    const subscriptionByOrg = orgId ? await this.getSubscriptionByOrg(orgId) : null;
    orgId = orgId ?? subscriptionByOrg?.org_id ?? null;

    const tierCandidates = [
      event.tierId,
      subscriptionByProvider?.tier_id,
      checkoutByTransaction?.requested_tier_id,
      checkoutBySubscription?.requested_tier_id,
      subscriptionByOrg?.tier_id,
    ].filter((value): value is string => Boolean(value));

    let tierId: string | null = null;
    for (const candidate of tierCandidates) {
      if (await this.isKnownTier(candidate)) {
        tierId = candidate;
        break;
      }
    }

    return {
      orgId,
      tierId,
      subscription: subscriptionByOrg ?? subscriptionByProvider,
      checkoutSession: checkoutByTransaction ?? checkoutBySubscription,
    };
  }

  private async insertCheckoutWebhookState(row: {
    org_id: string;
    requested_tier_id: string;
    provider: PaymentProvider;
    price_id: string | null;
    provider_transaction_id: string;
    provider_subscription_id: string | null;
    status: CheckoutLifecycleStatus;
    checkout_url: string | null;
    last_webhook_event_id: string;
    last_webhook_event_at: string;
  }) {
    const { data, error } = await this.supabase
      .from('subscription_checkout_sessions')
      .insert(row)
      .select('org_id, requested_tier_id, provider, price_id, provider_transaction_id, provider_subscription_id, status, checkout_url, last_webhook_event_id, last_webhook_event_at')
      .single();

    return { data: (data as CheckoutSessionRow | null) ?? null, error };
  }

  private async updateCheckoutWebhookStateIfCurrent(
    provider: PaymentProvider,
    providerTransactionId: string,
    occurredAt: string,
    patch: {
      org_id: string;
      requested_tier_id: string;
      provider_subscription_id: string | null;
      status: CheckoutLifecycleStatus;
      last_webhook_event_id: string;
      last_webhook_event_at: string;
    },
  ) {
    const base = () => this.supabase
      .from('subscription_checkout_sessions')
      .update(patch)
      .eq('provider', provider)
      .eq('provider_transaction_id', providerTransactionId);

    const { data: nullApplied, error: nullError } = await base()
      .is('last_webhook_event_at', null)
      .select('org_id, requested_tier_id, provider, price_id, provider_transaction_id, provider_subscription_id, status, checkout_url, last_webhook_event_id, last_webhook_event_at')
      .maybeSingle();
    if (nullError) throw nullError;
    if (nullApplied) return nullApplied as CheckoutSessionRow;

    const { data: orderedApplied, error: orderedError } = await base()
      .lte('last_webhook_event_at', occurredAt)
      .select('org_id, requested_tier_id, provider, price_id, provider_transaction_id, provider_subscription_id, status, checkout_url, last_webhook_event_id, last_webhook_event_at')
      .maybeSingle();
    if (orderedError) throw orderedError;
    return (orderedApplied as CheckoutSessionRow | null) ?? null;
  }

  private async applyCheckoutSessionEvent(
    provider: PaymentProvider,
    event: WebhookEvent,
    context: Awaited<ReturnType<SubscriptionService['resolveContext']>>,
  ) {
    const targetSession = context.checkoutSession;
    const providerTransactionId = event.providerTransactionId ?? targetSession?.provider_transaction_id ?? null;
    const status = event.checkoutStatus ?? targetSession?.status ?? null;

    if (!providerTransactionId || !status) return { changed: false, row: targetSession };

    const orgId = context.orgId ?? targetSession?.org_id ?? null;
    const tierId = context.tierId ?? targetSession?.requested_tier_id ?? null;
    if (!orgId || !tierId) throw new Error(`Cannot resolve checkout lifecycle context for ${event.type}`);

    const row = {
      org_id: orgId,
      requested_tier_id: tierId,
      provider,
      price_id: targetSession?.price_id ?? null,
      provider_transaction_id: providerTransactionId,
      provider_subscription_id: event.providerSubscriptionId ?? targetSession?.provider_subscription_id ?? null,
      status,
      checkout_url: targetSession?.checkout_url ?? null,
      last_webhook_event_id: event.eventId,
      last_webhook_event_at: event.occurredAt,
    };

    const inserted = await this.insertCheckoutWebhookState(row);
    if (!inserted.error) return { changed: true, row: inserted.data };
    if (!isUniqueViolation(inserted.error)) throw inserted.error;

    const updated = await this.updateCheckoutWebhookStateIfCurrent(
      provider,
      providerTransactionId,
      event.occurredAt,
      {
        org_id: orgId,
        requested_tier_id: tierId,
        provider_subscription_id: row.provider_subscription_id,
        status,
        last_webhook_event_id: event.eventId,
        last_webhook_event_at: event.occurredAt,
      },
    );

    if (updated) return { changed: true, row: updated };
    return {
      changed: false,
      row: await this.getCheckoutSessionByTransaction(provider, providerTransactionId),
    };
  }

  private async insertSubscriptionWebhookState(row: {
    org_id: string;
    tier_id: string;
    offering_snapshot_id: string;
    status: SubscriptionLifecycleStatus;
    payment_provider: PaymentProvider;
    provider_subscription_id: string | null;
    current_period_start: string | null;
    current_period_end: string | null;
    canceled_at: string | null;
    grace_period_end: string | null;
    last_webhook_event_id: string;
    last_webhook_event_at: string;
  }) {
    const { data, error } = await this.supabase
      .from('subscriptions')
      .insert(row)
      .select('org_id, tier_id, offering_snapshot_id, status, current_period_start, current_period_end, payment_provider, provider_subscription_id, canceled_at, grace_period_end, last_webhook_event_id, last_webhook_event_at')
      .single();

    return { data: (data as SubscriptionRow | null) ?? null, error };
  }

  private async updateSubscriptionWebhookStateIfCurrent(
    orgId: string,
    occurredAt: string,
    patch: {
      tier_id: string;
      offering_snapshot_id: string;
      status: SubscriptionLifecycleStatus;
      payment_provider: PaymentProvider;
      provider_subscription_id: string | null;
      current_period_start: string | null;
      current_period_end: string | null;
      canceled_at: string | null;
      grace_period_end: string | null;
      last_webhook_event_id: string;
      last_webhook_event_at: string;
    },
  ) {
    const base = () => this.supabase
      .from('subscriptions')
      .update(patch)
      .eq('org_id', orgId);

    const { data: nullApplied, error: nullError } = await base()
      .is('last_webhook_event_at', null)
      .select('org_id, tier_id, offering_snapshot_id, status, current_period_start, current_period_end, payment_provider, provider_subscription_id, canceled_at, grace_period_end, last_webhook_event_id, last_webhook_event_at')
      .maybeSingle();
    if (nullError) throw nullError;
    if (nullApplied) return nullApplied as SubscriptionRow;

    const { data: orderedApplied, error: orderedError } = await base()
      .lte('last_webhook_event_at', occurredAt)
      .select('org_id, tier_id, offering_snapshot_id, status, current_period_start, current_period_end, payment_provider, provider_subscription_id, canceled_at, grace_period_end, last_webhook_event_id, last_webhook_event_at')
      .maybeSingle();
    if (orderedError) throw orderedError;
    return (orderedApplied as SubscriptionRow | null) ?? null;
  }

  private async applySubscriptionState(
    provider: PaymentProvider,
    event: WebhookEvent,
    context: Awaited<ReturnType<SubscriptionService['resolveContext']>>,
    state: {
      status: SubscriptionLifecycleStatus;
      currentPeriodStart: string | null;
      currentPeriodEnd: string | null;
      canceledAt: string | null;
      gracePeriodEnd: string | null;
    },
  ) {
    if (!context.orgId || !context.tierId) throw new Error(`Cannot resolve subscription context for ${event.type}`);

    const snapshotId = await this.resolveSnapshotId(context.tierId, context.subscription);
    const row = {
      org_id: context.orgId,
      tier_id: context.tierId,
      offering_snapshot_id: snapshotId,
      status: state.status,
      payment_provider: provider,
      provider_subscription_id: event.providerSubscriptionId,
      current_period_start: state.currentPeriodStart,
      current_period_end: state.currentPeriodEnd,
      canceled_at: state.canceledAt,
      grace_period_end: state.gracePeriodEnd,
      last_webhook_event_id: event.eventId,
      last_webhook_event_at: event.occurredAt,
    };

    const inserted = await this.insertSubscriptionWebhookState(row);
    if (!inserted.error) return { changed: true, row: inserted.data };
    if (!isUniqueViolation(inserted.error)) throw inserted.error;

    const updated = await this.updateSubscriptionWebhookStateIfCurrent(
      context.orgId,
      event.occurredAt,
      {
        tier_id: context.tierId,
        offering_snapshot_id: snapshotId,
        status: state.status,
        payment_provider: provider,
        provider_subscription_id: event.providerSubscriptionId,
        current_period_start: state.currentPeriodStart,
        current_period_end: state.currentPeriodEnd,
        canceled_at: state.canceledAt,
        grace_period_end: state.gracePeriodEnd,
        last_webhook_event_id: event.eventId,
        last_webhook_event_at: event.occurredAt,
      },
    );

    if (updated) return { changed: true, row: updated };
    return {
      changed: false,
      row: await this.getSubscriptionByOrg(context.orgId),
    };
  }

  private async syncCheckoutLifecycle(
    event: WebhookEvent,
    provider: PaymentProvider,
    context: Awaited<ReturnType<SubscriptionService['resolveContext']>>,
  ) {
    return this.applyCheckoutSessionEvent(provider, event, context);
  }

  private async syncSubscriptionLifecycle(
    event: WebhookEvent,
    provider: PaymentProvider,
    context: Awaited<ReturnType<SubscriptionService['resolveContext']>>,
  ) {
    if (!event.subscriptionStatus) return { changed: false, row: context.subscription };

    switch (event.subscriptionStatus) {
      case 'active':
      case 'trialing':
        return this.applySubscriptionState(provider, event, context, {
          status: event.subscriptionStatus,
          currentPeriodStart: event.currentPeriodStart,
          currentPeriodEnd: event.currentPeriodEnd,
          canceledAt: null,
          gracePeriodEnd: null,
        });

      case 'past_due':
        return this.applySubscriptionState(provider, event, context, {
          status: 'past_due',
          currentPeriodStart: event.currentPeriodStart ?? context.subscription?.current_period_start ?? null,
          currentPeriodEnd: event.currentPeriodEnd ?? context.subscription?.current_period_end ?? null,
          canceledAt: null,
          gracePeriodEnd: context.subscription?.grace_period_end ?? null,
        });

      case 'canceled': {
        const gracePeriodEnd = context.subscription?.grace_period_end
          ?? context.subscription?.current_period_end
          ?? event.currentPeriodEnd
          ?? event.occurredAt;
        return this.applySubscriptionState(provider, event, context, {
          status: 'canceled',
          currentPeriodStart: context.subscription?.current_period_start ?? event.currentPeriodStart ?? null,
          currentPeriodEnd: context.subscription?.current_period_end ?? event.currentPeriodEnd ?? null,
          canceledAt: event.occurredAt,
          gracePeriodEnd,
        });
      }
    }
  }

  /** AC6: 웹훅 이벤트 분기 처리 */
  async processWebhookEvent(event: WebhookEvent, provider: PaymentProvider) {
    const context = await this.resolveContext(event, provider);
    const checkout = await this.syncCheckoutLifecycle(event, provider, context);
    const subscription = await this.syncSubscriptionLifecycle(event, provider, context);

    return {
      eventId: event.eventId,
      type: event.type,
      checkoutChanged: checkout.changed,
      subscriptionChanged: subscription.changed,
      checkoutStatus: checkout.row?.status ?? event.checkoutStatus,
      subscriptionStatus: subscription.row?.status ?? event.subscriptionStatus,
      duplicateOrStale: !checkout.changed && !subscription.changed,
    };
  }
}
