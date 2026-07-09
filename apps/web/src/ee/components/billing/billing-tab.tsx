'use client';

/**
 * EE-only Billing tab — S5.2 상태 표시 + S5.3 Polar Checkout 연동.
 * isEEEnabled()=true 환경에서만 렌더링됨.
 */

import { useEffect, useState } from 'react';
import { CheckCircle, CreditCard, Loader2, Shield } from 'lucide-react';

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

const FASTAPI_URL = () => process.env['NEXT_PUBLIC_FASTAPI_URL'] ?? 'http://localhost:8000';

const TIER_BADGE: Record<string, string> = {
  free: 'bg-gray-100 text-gray-700',
  team: 'bg-blue-100 text-blue-700',
  pro: 'bg-purple-100 text-purple-700',
};

const STATUS_BADGE: Record<string, string> = {
  active: 'bg-green-100 text-green-700',
  past_due: 'bg-yellow-100 text-yellow-700',
  cancelled: 'bg-destructive-tint text-destructive',
};

const PLAN_PRICES: Record<string, { monthly: number; yearly: number }> = {
  team: { monthly: 29, yearly: 23 },
  pro: { monthly: 79, yearly: 63 },
};

export function BillingTab({ orgId }: { orgId: string }) {
  const [status, setStatus] = useState<BillingStatus | null>(null);
  const [plans, setPlans] = useState<Plan[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedPlan, setSelectedPlan] = useState<string>('team');
  const [selectedCycle, setSelectedCycle] = useState<'monthly' | 'yearly'>('monthly');
  const [checkingOut, setCheckingOut] = useState(false);

  useEffect(() => {
    Promise.all([
      fetch(`${FASTAPI_URL()}/api/v2/billing/status`, { credentials: 'include' }).then((r) => r.json() as Promise<BillingStatus>),
      fetch(`${FASTAPI_URL()}/api/v2/billing/plans`, { credentials: 'include' }).then((r) => r.json() as Promise<Plan[]>),
    ])
      .then(([s, p]) => { setStatus(s); setPlans(p.filter((pl) => pl.id !== 'free')); })
      .catch(() => setError('Billing 정보를 불러올 수 없는.'))
      .finally(() => setLoading(false));
  }, [orgId]);

  const handleCheckout = async () => {
    if (!status?.can_manage) return;
    setCheckingOut(true);
    try {
      const res = await fetch(`${FASTAPI_URL()}/api/v2/billing/checkout`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ plan_id: selectedPlan, billing_cycle: selectedCycle }),
      });
      const json = await res.json() as { checkout_url?: string; detail?: string };
      if (!res.ok) throw new Error(json.detail ?? 'Checkout failed');
      if (json.checkout_url) {
        window.location.href = json.checkout_url;
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Checkout error');
      setCheckingOut(false);
    }
  };

  if (loading) return <div className="p-6 text-sm text-muted-foreground flex items-center gap-2"><Loader2 className="h-4 w-4 animate-spin" />Loading...</div>;
  if (error) return <div className="p-6 text-sm text-destructive">{error}</div>;

  const currentPlan = [...plans, { id: 'free', name: 'Free', price: 0, billing_cycle: null, features: ['1 project', '5 members', 'Basic AI features'] }].find((p) => p.id === status?.tier);

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
          <span className={`px-2 py-0.5 rounded text-xs font-medium ${STATUS_BADGE[status?.status ?? 'active'] ?? 'bg-gray-100 text-gray-700'}`}>
            {status?.status ?? 'active'}
          </span>
          {status?.billing_cycle && <span className="text-xs text-muted-foreground">{status.billing_cycle}</span>}
          {status?.current_period_end && (
            <span className="text-xs text-muted-foreground">
              갱신일: {new Date(status.current_period_end).toLocaleDateString('ko-KR')}
            </span>
          )}
        </div>
        {currentPlan && (
          <ul className="space-y-1 text-sm text-muted-foreground">
            {currentPlan.features.map((f) => (
              <li key={f} className="flex items-center gap-2"><CheckCircle className="h-4 w-4 text-green-500 shrink-0" />{f}</li>
            ))}
          </ul>
        )}
      </section>

      {/* Checkout — owner/admin 전용 */}
      {status?.can_manage && (
        <section className="rounded-lg border p-4 space-y-4">
          <div className="flex items-center gap-2">
            <Shield className="h-4 w-4 text-muted-foreground" />
            <h3 className="font-semibold text-sm">플랜 업그레이드</h3>
          </div>

          {/* 결제 주기 토글 */}
          <div className="flex gap-2">
            {(['monthly', 'yearly'] as const).map((cycle) => (
              <button
                key={cycle}
                onClick={() => setSelectedCycle(cycle)}
                className={`px-3 py-1 rounded text-sm font-medium border transition-colors ${selectedCycle === cycle ? 'bg-primary text-primary-foreground border-primary' : 'border-border text-muted-foreground hover:border-primary/50'}`}
              >
                {cycle === 'monthly' ? '월간' : '연간'}
                {cycle === 'yearly' && <span className="ml-1 text-xs text-green-600">(20% 할인)</span>}
              </button>
            ))}
          </div>

          {/* 플랜 선택 */}
          <div className="grid gap-3 sm:grid-cols-2">
            {plans.map((plan) => {
              const prices = PLAN_PRICES[plan.id];
              const price = prices ? prices[selectedCycle] : plan.price;
              return (
                <button
                  key={plan.id}
                  onClick={() => setSelectedPlan(plan.id)}
                  className={`rounded-lg border p-4 text-left space-y-2 transition-colors ${selectedPlan === plan.id ? 'border-primary bg-primary/5' : 'border-border hover:border-primary/30'}`}
                >
                  <div className="flex items-center justify-between">
                    <span className="font-medium">{plan.name}</span>
                    <span className="text-sm font-semibold">${price}/mo</span>
                  </div>
                  <ul className="space-y-1 text-xs text-muted-foreground">
                    {plan.features.map((f) => (
                      <li key={f} className="flex items-center gap-1.5"><CheckCircle className="h-3 w-3 text-green-500 shrink-0" />{f}</li>
                    ))}
                  </ul>
                </button>
              );
            })}
          </div>

          <button
            onClick={handleCheckout}
            disabled={checkingOut}
            className="w-full flex items-center justify-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50 transition-colors"
          >
            {checkingOut ? <><Loader2 className="h-4 w-4 animate-spin" />처리 중...</> : `${selectedPlan === 'team' ? 'Team' : 'Pro'} ${selectedCycle === 'monthly' ? '월간' : '연간'} 시작하기`}
          </button>

          <p className="text-xs text-muted-foreground text-center">
            Polar 결제 포털로 이동합니다. 취소 시 이 화면으로 돌아옵니다.
          </p>
        </section>
      )}

      {/* member 안내 */}
      {status && !status.can_manage && (
        <section className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
          결제 관리는 owner 또는 admin만 가능한. 플랜 변경이 필요하면 관리자에게 문의하면 됩니다.
        </section>
      )}
    </div>
  );
}
