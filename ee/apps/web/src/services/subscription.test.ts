import { describe, expect, it } from 'vitest';
import { SubscriptionService } from './subscription';
import type { CheckoutLifecycleStatus, PaymentProvider, WebhookEvent } from '@/lib/payment/types';

interface SubscriptionRow {
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
}

interface CheckoutSessionRow {
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
}

type Filter = { kind: 'eq' | 'is' | 'lte'; column: string; value: unknown };

function createSupabaseStub(options?: {
  subscriptions?: SubscriptionRow[];
  checkoutSessions?: CheckoutSessionRow[];
  planTiers?: Array<{ id: string }>;
  planOfferingSnapshots?: Array<{ id: string; tier_id: string; effective_until: string | null; version: number }>;
}) {
  const state = {
    subscriptions: options?.subscriptions ?? [],
    checkoutSessions: options?.checkoutSessions ?? [],
    planTiers: options?.planTiers ?? [{ id: 'tier-team' }, { id: 'tier-pro' }, { id: '00000000-0000-0000-0000-000000000a01' }],
    planOfferingSnapshots: options?.planOfferingSnapshots ?? [
      { id: 'snap-team-v1', tier_id: 'tier-team', effective_until: null, version: 1 },
      { id: 'snap-pro-v1', tier_id: 'tier-pro', effective_until: null, version: 1 },
      { id: 'snap-free-v1', tier_id: '00000000-0000-0000-0000-000000000a01', effective_until: null, version: 1 },
    ],
  };

  function matches(row: Record<string, unknown>, filters: Filter[]) {
    return filters.every((filter) => {
      const value = row[filter.column];
      if (filter.kind === 'eq') return value === filter.value;
      if (filter.kind === 'is') return filter.value === null ? value == null : value === filter.value;
      if (filter.kind === 'lte') {
        if (value == null) return false;
        return String(value) <= String(filter.value);
      }
      return true;
    });
  }

  function createSelectBuilder(rowsFactory: () => Array<Record<string, unknown>>) {
    const filters: Filter[] = [];
    let orderColumn: string | null = null;
    let ascending = true;
    const builder = {
      select() { return builder; },
      eq(column: string, value: unknown) { filters.push({ kind: 'eq', column, value }); return builder; },
      is(column: string, value: unknown) { filters.push({ kind: 'is', column, value }); return builder; },
      lte(column: string, value: unknown) { filters.push({ kind: 'lte', column, value }); return builder; },
      order(column: string, options?: { ascending?: boolean }) { orderColumn = column; ascending = options?.ascending ?? true; return builder; },
      maybeSingle: async () => {
        let rows = rowsFactory().filter((row) => matches(row, filters));
        if (orderColumn) {
          rows = rows.sort((a, b) => ascending
            ? Number(a[orderColumn as keyof typeof a]) - Number(b[orderColumn as keyof typeof b])
            : Number(b[orderColumn as keyof typeof b]) - Number(a[orderColumn as keyof typeof a]));
        }
        return { data: rows[0] ?? null, error: null };
      },
      single: async () => {
        const rows = rowsFactory().filter((row) => matches(row, filters));
        return { data: rows[0] ?? null, error: rows[0] ? null : { code: 'PGRST116', message: 'Row not found' } };
      },
    };
    return builder;
  }

  function createUpdateBuilder<T extends Record<string, unknown>>(rows: T[]) {
    return (payload: Record<string, unknown>) => {
      const filters: Filter[] = [];
      const builder = {
        eq(column: string, value: unknown) { filters.push({ kind: 'eq', column, value }); return builder; },
        is(column: string, value: unknown) { filters.push({ kind: 'is', column, value }); return builder; },
        lte(column: string, value: unknown) { filters.push({ kind: 'lte', column, value }); return builder; },
        select() {
          return {
            maybeSingle: async () => {
              const row = rows.find((item) => matches(item as unknown as Record<string, unknown>, filters));
              if (!row) return { data: null, error: null };
              Object.assign(row, payload);
              return { data: row, error: null };
            },
            single: async () => {
              const row = rows.find((item) => matches(item as unknown as Record<string, unknown>, filters));
              if (!row) return { data: null, error: { code: 'PGRST116', message: 'Row not found' } };
              Object.assign(row, payload);
              return { data: row, error: null };
            },
          };
        },
      };
      return builder;
    };
  }

  function buildSubscriptionRow(payload: Record<string, unknown>): SubscriptionRow {
    return {
      org_id: String(payload.org_id),
      tier_id: (payload.tier_id as string | null | undefined) ?? null,
      offering_snapshot_id: (payload.offering_snapshot_id as string | null | undefined) ?? null,
      status: String(payload.status ?? 'active'),
      current_period_start: (payload.current_period_start as string | null | undefined) ?? null,
      current_period_end: (payload.current_period_end as string | null | undefined) ?? null,
      payment_provider: (payload.payment_provider as PaymentProvider | null | undefined) ?? null,
      provider_subscription_id: (payload.provider_subscription_id as string | null | undefined) ?? null,
      canceled_at: (payload.canceled_at as string | null | undefined) ?? null,
      grace_period_end: (payload.grace_period_end as string | null | undefined) ?? null,
      last_webhook_event_id: (payload.last_webhook_event_id as string | null | undefined) ?? null,
      last_webhook_event_at: (payload.last_webhook_event_at as string | null | undefined) ?? null,
    };
  }

  function buildCheckoutRow(payload: Record<string, unknown>): CheckoutSessionRow {
    return {
      org_id: String(payload.org_id),
      requested_tier_id: (payload.requested_tier_id as string | null | undefined) ?? null,
      provider: payload.provider as PaymentProvider,
      price_id: (payload.price_id as string | null | undefined) ?? null,
      provider_transaction_id: String(payload.provider_transaction_id),
      provider_subscription_id: (payload.provider_subscription_id as string | null | undefined) ?? null,
      status: payload.status as CheckoutLifecycleStatus,
      checkout_url: (payload.checkout_url as string | null | undefined) ?? null,
      last_webhook_event_id: (payload.last_webhook_event_id as string | null | undefined) ?? null,
      last_webhook_event_at: (payload.last_webhook_event_at as string | null | undefined) ?? null,
    };
  }

  const supabase = {
    from(table: string) {
      if (table === 'plan_tiers') {
        return createSelectBuilder(() => state.planTiers as unknown as Array<Record<string, unknown>>);
      }

      if (table === 'plan_offering_snapshots') {
        return createSelectBuilder(() => state.planOfferingSnapshots as unknown as Array<Record<string, unknown>>);
      }

      if (table === 'subscriptions') {
        return {
          ...createSelectBuilder(() => state.subscriptions as unknown as Array<Record<string, unknown>>),
          upsert(payload: Record<string, unknown>) {
            const row = buildSubscriptionRow(payload);
            const index = state.subscriptions.findIndex((item) => item.org_id === row.org_id);
            if (index >= 0) state.subscriptions[index] = { ...state.subscriptions[index], ...row };
            else state.subscriptions.push(row);
            return {
              select() {
                return {
                  single: async () => ({ data: row, error: null }),
                };
              },
            };
          },
          insert(payload: Record<string, unknown>) {
            const row = buildSubscriptionRow(payload);
            const exists = state.subscriptions.some((item) => item.org_id === row.org_id);
            return {
              select() {
                return {
                  single: async () => exists
                    ? { data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint' } }
                    : (() => {
                        state.subscriptions.push(row);
                        return { data: row, error: null };
                      })(),
                };
              },
            };
          },
          update: createUpdateBuilder(state.subscriptions as unknown as Array<Record<string, unknown>>),
        };
      }

      if (table === 'subscription_checkout_sessions') {
        return {
          ...createSelectBuilder(() => state.checkoutSessions as unknown as Array<Record<string, unknown>>),
          upsert(payload: Record<string, unknown>) {
            const row = buildCheckoutRow(payload);
            const index = state.checkoutSessions.findIndex((item) => item.provider === row.provider && item.provider_transaction_id === row.provider_transaction_id);
            if (index >= 0) state.checkoutSessions[index] = { ...state.checkoutSessions[index], ...row };
            else state.checkoutSessions.push(row);
            return {
              select() {
                return {
                  single: async () => ({ data: row, error: null }),
                };
              },
            };
          },
          insert(payload: Record<string, unknown>) {
            const row = buildCheckoutRow(payload);
            const exists = state.checkoutSessions.some((item) => item.provider === row.provider && item.provider_transaction_id === row.provider_transaction_id);
            return {
              select() {
                return {
                  single: async () => exists
                    ? { data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint' } }
                    : (() => {
                        state.checkoutSessions.push(row);
                        return { data: row, error: null };
                      })(),
                };
              },
            };
          },
          update: createUpdateBuilder(state.checkoutSessions as unknown as Array<Record<string, unknown>>),
        };
      }

      throw new Error(`Unexpected table ${table}`);
    },
  };

  return { supabase: supabase as never, state };
}

function createWebhookEvent(overrides: Partial<WebhookEvent>): WebhookEvent {
  return {
    type: 'transaction.created',
    eventId: 'evt_1',
    occurredAt: '2026-04-11T09:00:00.000Z',
    providerSubscriptionId: null,
    providerTransactionId: 'txn_1',
    orgId: 'org-1',
    tierId: 'tier-team',
    currentPeriodStart: null,
    currentPeriodEnd: null,
    checkoutStatus: 'pending',
    subscriptionStatus: null,
    ...overrides,
  };
}

describe('SubscriptionService', () => {
  it('tracks checkout lifecycle from pending to completed', async () => {
    const { supabase, state } = createSupabaseStub();
    const service = new SubscriptionService(supabase);

    await service.processWebhookEvent(createWebhookEvent({
      type: 'transaction.created',
      eventId: 'evt_created',
      checkoutStatus: 'pending',
    }), 'paddle');

    await service.processWebhookEvent(createWebhookEvent({
      type: 'transaction.completed',
      eventId: 'evt_completed',
      occurredAt: '2026-04-11T09:05:00.000Z',
      checkoutStatus: 'completed',
    }), 'paddle');

    expect(state.checkoutSessions).toHaveLength(1);
    expect(state.checkoutSessions[0]).toMatchObject({
      provider_transaction_id: 'txn_1',
      status: 'completed',
      last_webhook_event_id: 'evt_completed',
    });
  });

  it('resolves missing org and tier from the checkout session and activates entitlement on subscription.created', async () => {
    const { supabase, state } = createSupabaseStub();
    const service = new SubscriptionService(supabase);

    await service.recordCheckoutSession({
      orgId: 'org-1',
      tierId: 'tier-team',
      provider: 'paddle',
      priceId: 'pri_team_monthly',
      providerTransactionId: 'txn_1',
      checkoutUrl: 'https://pay.example.test/txn_1',
    });

    await service.processWebhookEvent(createWebhookEvent({
      type: 'subscription.created',
      eventId: 'evt_subscription_created',
      occurredAt: '2026-04-11T09:10:00.000Z',
      providerSubscriptionId: 'sub_1',
      orgId: null,
      tierId: null,
      currentPeriodStart: '2026-04-11T09:10:00.000Z',
      currentPeriodEnd: '2026-05-11T09:10:00.000Z',
      checkoutStatus: 'completed',
      subscriptionStatus: 'trialing',
    }), 'paddle');

    expect(state.checkoutSessions[0]).toMatchObject({
      provider_transaction_id: 'txn_1',
      provider_subscription_id: 'sub_1',
      status: 'completed',
    });
    expect(state.subscriptions[0]).toMatchObject({
      org_id: 'org-1',
      tier_id: 'tier-team',
      offering_snapshot_id: 'snap-team-v1',
      status: 'trialing',
      payment_provider: 'paddle',
      provider_subscription_id: 'sub_1',
      last_webhook_event_id: 'evt_subscription_created',
    });
  });

  it('keeps a newer webhook state when an older event arrives later', async () => {
    const { supabase, state } = createSupabaseStub({
      subscriptions: [{
        org_id: 'org-1',
        tier_id: 'tier-team',
        offering_snapshot_id: 'snap-team-v1',
        status: 'active',
        current_period_start: '2026-04-11T10:00:00.000Z',
        current_period_end: '2026-05-11T10:00:00.000Z',
        payment_provider: 'paddle',
        provider_subscription_id: 'sub_1',
        canceled_at: null,
        grace_period_end: null,
        last_webhook_event_id: 'evt_latest',
        last_webhook_event_at: '2026-04-11T10:00:00.000Z',
      }],
      checkoutSessions: [{
        org_id: 'org-1',
        requested_tier_id: 'tier-team',
        provider: 'paddle',
        price_id: 'pri_team_monthly',
        provider_transaction_id: 'txn_1',
        provider_subscription_id: 'sub_1',
        status: 'completed',
        checkout_url: 'https://pay.example.test/txn_1',
        last_webhook_event_id: 'evt_latest',
        last_webhook_event_at: '2026-04-11T10:00:00.000Z',
      }],
    });
    const service = new SubscriptionService(supabase);

    const stale = await service.processWebhookEvent(createWebhookEvent({
      type: 'subscription.past_due',
      eventId: 'evt_stale',
      occurredAt: '2026-04-11T09:00:00.000Z',
      providerSubscriptionId: 'sub_1',
      currentPeriodStart: '2026-04-11T09:00:00.000Z',
      currentPeriodEnd: '2026-05-11T09:00:00.000Z',
      checkoutStatus: null,
      subscriptionStatus: 'past_due',
    }), 'paddle');

    expect(stale.duplicateOrStale).toBe(true);
    expect(state.subscriptions[0]).toMatchObject({
      status: 'active',
      last_webhook_event_id: 'evt_latest',
      offering_snapshot_id: 'snap-team-v1',
    });
    expect(state.checkoutSessions[0]).toMatchObject({
      status: 'completed',
      last_webhook_event_id: 'evt_latest',
    });
  });
});
