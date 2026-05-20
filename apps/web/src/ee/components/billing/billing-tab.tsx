'use client';

/**
 * EE-only Billing tab — tier/billing_cycle/status 표시 + 플랜 카탈로그 + 역할별 액션.
 * isEEEnabled()=true 환경에서만 렌더링됨 (settings/page.tsx 조건부 처리).
 */

import { useEffect, useState } from 'react';
import { CheckCircle, CreditCard, Shield } from 'lucide-react';

interface BillingStatus {
  org_id: string;
  tier: string;
  billing_cycle: string | null;
  status: string;
  current_period_end: string | null;
  can_manage: boolean;
}

interface Plan {
  id: string;
  name: string;
  price: number;
  billing_cycle: string | null;
  features: string[];
}

const FASTAPI_URL = () => process.env.NEXT_PUBLIC_FASTAPI_URL ?? 'http://localhost:8000';

const TIER_BADGE: Record<string, string> = {
  free: 'bg-gray-100 text-gray-700',
  team: 'bg-blue-100 text-blue-700',
  pro: 'bg-purple-100 text-purple-700',
};

const STATUS_BADGE: Record<string, string> = {
  active: 'bg-green-100 text-green-700',
  past_due: 'bg-yellow-100 text-yellow-700',
  cancelled: 'bg-red-100 text-red-700',
};

export function BillingTab({ orgId }: { orgId: string }) {
  const [status, setStatus] = useState<BillingStatus | null>(null);
  const [plans, setPlans] = useState<Plan[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([
      fetch(`${FASTAPI_URL()}/api/v2/billing/status`, { credentials: 'include' }).then((r) => r.json()),
      fetch(`${FASTAPI_URL()}/api/v2/billing/plans`, { credentials: 'include' }).then((r) => r.json()),
    ])
      .then(([s, p]: [BillingStatus, Plan[]]) => {
        setStatus(s);
        setPlans(p);
      })
      .catch(() => setError('Billing 정보를 불러올 수 없는.'))
      .finally(() => setLoading(false));
  }, [orgId]);

  if (loading) return <div className="p-6 text-sm text-muted-foreground">Loading...</div>;
  if (error) return <div className="p-6 text-sm text-destructive">{error}</div>;

  const currentPlan = plans.find((p) => p.id === status?.tier);

  return (
    <div className="space-y-6 p-6">
      {/* 현재 구독 상태 */}
      <section className="rounded-lg border p-4 space-y-3">
        <div className="flex items-center gap-2">
          <CreditCard className="h-5 w-5 text-muted-foreground" />
          <h3 className="font-semibold text-base">현재 플랜</h3>
        </div>
        <div className="flex items-center gap-3 flex-wrap">
          <span className={`px-2 py-0.5 rounded text-xs font-medium capitalize ${TIER_BADGE[status?.tier ?? 'free'] ?? 'bg-gray-100 text-gray-700'}`}>
            {status?.tier ?? 'free'}
          </span>
          <span className={`px-2 py-0.5 rounded text-xs font-medium capitalize ${STATUS_BADGE[status?.status ?? 'active'] ?? 'bg-gray-100 text-gray-700'}`}>
            {status?.status ?? 'active'}
          </span>
          {status?.billing_cycle && (
            <span className="text-xs text-muted-foreground">{status.billing_cycle}</span>
          )}
          {status?.current_period_end && (
            <span className="text-xs text-muted-foreground">
              갱신일: {new Date(status.current_period_end).toLocaleDateString('ko-KR')}
            </span>
          )}
        </div>
        {currentPlan && (
          <ul className="space-y-1 text-sm text-muted-foreground">
            {currentPlan.features.map((f) => (
              <li key={f} className="flex items-center gap-2">
                <CheckCircle className="h-4 w-4 text-green-500 shrink-0" />
                {f}
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* 플랜 카탈로그 */}
      <section className="space-y-3">
        <h3 className="font-semibold text-base">플랜 비교</h3>
        <div className="grid gap-3 sm:grid-cols-3">
          {plans.map((plan) => (
            <div
              key={plan.id}
              className={`rounded-lg border p-4 space-y-2 ${plan.id === status?.tier ? 'border-primary bg-primary/5' : ''}`}
            >
              <div className="flex items-center justify-between">
                <span className="font-medium">{plan.name}</span>
                <span className="text-sm font-semibold">
                  {plan.price === 0 ? 'Free' : `$${plan.price}/mo`}
                </span>
              </div>
              <ul className="space-y-1 text-xs text-muted-foreground">
                {plan.features.map((f) => (
                  <li key={f} className="flex items-center gap-1.5">
                    <CheckCircle className="h-3 w-3 text-green-500 shrink-0" />
                    {f}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </section>

      {/* owner/admin 전용 관리 액션 */}
      {status?.can_manage && (
        <section className="rounded-lg border border-dashed p-4 space-y-2">
          <div className="flex items-center gap-2">
            <Shield className="h-4 w-4 text-muted-foreground" />
            <h3 className="font-medium text-sm">결제 관리</h3>
            <span className="text-xs text-muted-foreground">(owner / admin)</span>
          </div>
          <p className="text-xs text-muted-foreground">
            Polar 결제 포털 연동 예정 — S5.3에서 구현됩니다.
          </p>
        </section>
      )}
    </div>
  );
}
