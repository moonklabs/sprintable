import { describe, expect, it } from 'vitest';

import { checkFeatureLimit, checkResourceLimit } from './check-feature';

type Row = Record<string, unknown>;

function createSupabaseStub(state: {
  orgSubscriptions?: Row[];
  subscriptions?: Row[];
  planOfferingSnapshots?: Row[];
  planTiers?: Row[];
  planFeatures?: Row[];
  docs?: Row[];
}) {
  function applyFilters(rows: Row[], filters: Array<{ kind: 'eq' | 'in' | 'is'; column: string; value: unknown }>) {
    return rows.filter((row) => filters.every((filter) => {
      const value = row[filter.column];
      if (filter.kind === 'eq') return value === filter.value;
      if (filter.kind === 'is') return filter.value === null ? value == null : value === filter.value;
      if (filter.kind === 'in') return Array.isArray(filter.value) && filter.value.includes(value);
      return true;
    }));
  }

  function createSelectBuilder(rowsFactory: () => Row[]) {
    const filters: Array<{ kind: 'eq' | 'in' | 'is'; column: string; value: unknown }> = [];
    let orderBy: { column: string; ascending: boolean } | null = null;
    let rowLimit: number | null = null;

    const resolveRows = () => {
      let rows = applyFilters(rowsFactory(), filters);
      if (orderBy) {
        const currentOrder = orderBy;
        rows = [...rows].sort((a, b) => {
          const left = a[currentOrder.column];
          const right = b[currentOrder.column];
          if (left === right) return 0;
          if (left == null) return currentOrder.ascending ? -1 : 1;
          if (right == null) return currentOrder.ascending ? 1 : -1;
          return left < right ? (currentOrder.ascending ? -1 : 1) : (currentOrder.ascending ? 1 : -1);
        });
      }
      if (rowLimit != null) rows = rows.slice(0, rowLimit);
      return rows;
    };

    const builder = {
      select() { return builder; },
      eq(column: string, value: unknown) { filters.push({ kind: 'eq', column, value }); return builder; },
      in(column: string, value: unknown[]) { filters.push({ kind: 'in', column, value }); return builder; },
      is(column: string, value: unknown) { filters.push({ kind: 'is', column, value }); return builder; },
      order(column: string, options?: { ascending?: boolean }) {
        orderBy = { column, ascending: options?.ascending ?? true };
        return builder;
      },
      limit(value: number) {
        rowLimit = value;
        return builder;
      },
      single: async () => ({ data: resolveRows()[0] ?? null, error: null }),
      maybeSingle: async () => ({ data: resolveRows()[0] ?? null, error: null }),
      then(resolve: (value: { data: Row[]; count: number; error: null }) => unknown) {
        const rows = resolveRows();
        return Promise.resolve({ data: rows, count: rows.length, error: null }).then(resolve);
      },
    };

    return builder;
  }

  return {
    from(table: string) {
      if (table === 'org_subscriptions') return createSelectBuilder(() => state.orgSubscriptions ?? []);
      if (table === 'subscriptions') return createSelectBuilder(() => state.subscriptions ?? []);
      if (table === 'plan_offering_snapshots') return createSelectBuilder(() => state.planOfferingSnapshots ?? []);
      if (table === 'plan_tiers') return createSelectBuilder(() => state.planTiers ?? []);
      if (table === 'plan_features') return createSelectBuilder(() => state.planFeatures ?? []);
      if (table === 'docs') return createSelectBuilder(() => state.docs ?? []);
      throw new Error(`Unexpected table ${table}`);
    },
  };
}

describe('check-feature', () => {
  it('uses trialing subscription snapshots as the entitlement source', async () => {
    const supabase = createSupabaseStub({
      orgSubscriptions: [{ org_id: 'org-1', tier: 'team', status: 'trialing' }],
      planTiers: [{ id: 'tier-team', name: 'team' }],
    });

    const result = await checkFeatureLimit(supabase as never, 'org-1', 'agent_orchestration');

    expect(result).toEqual({ allowed: true });
  });

  it('falls back to the current free snapshot when there is no entitled subscription', async () => {
    const supabase = createSupabaseStub({
      planTiers: [{ id: 'tier-free-id', name: 'free' }],
      planFeatures: [{ tier_id: 'tier-free-id', feature_key: 'agent_orchestration', enabled: false }],
    });

    const result = await checkFeatureLimit(supabase as never, 'org-1', 'agent_orchestration');

    expect(result.allowed).toBe(false);
    expect(result.upgradeRequired).toBe(true);
  });

  it('falls back to legacy plan_features when a subscription has no snapshot yet', async () => {
    const supabase = createSupabaseStub({
      orgSubscriptions: [{ org_id: 'org-1', tier: 'free', status: 'active' }],
      planTiers: [{ id: 'tier-free', name: 'free' }],
      planFeatures: [{ tier_id: 'tier-free', feature_key: 'max_docs', enabled: true, limit_value: 10 }],
      docs: Array.from({ length: 10 }, (_, index) => ({ id: `doc-${index + 1}`, org_id: 'org-1' })),
    });

    const result = await checkResourceLimit(supabase as never, 'org-1', 'max_docs', 'docs');

    expect(result.allowed).toBe(false);
    expect(result.upgradeRequired).toBe(true);
    expect(result.reason).toContain('max_docs limit reached (10)');
  });
});
