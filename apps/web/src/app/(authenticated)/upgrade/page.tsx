'use client';

import { useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';

const SANDBOX_PRODUCTS = {
  team_monthly: '200c2c3c-1235-41e1-a259-1440200b4a93',
  team_yearly: 'e79b7587-6261-4384-abdb-f3fd13612f06',
  pro_monthly: '9e3c0067-7d28-4314-abe8-c59929eedf30',
  pro_yearly: '39462386-91b7-4864-9cc2-eecc8cfc2307',
} as const;

interface PlanTier {
  price: string;
  productId: string;
  savings?: string;
}

interface Plan {
  key: string;
  name: string;
  description: string;
  monthly: PlanTier;
  yearly: PlanTier;
  features: string[];
  highlighted?: boolean;
}

const PLANS: Plan[] = [
  {
    key: 'team',
    name: 'Team',
    description: '성장하는 팀을 위한 협업 플랜',
    monthly: { price: '$49', productId: SANDBOX_PRODUCTS.team_monthly },
    yearly: { price: '$490', productId: SANDBOX_PRODUCTS.team_yearly, savings: '17% 절약' },
    features: ['무제한 스프린트', '팀 멤버 20명', 'AI 에이전트 협업', 'Slack 연동'],
  },
  {
    key: 'pro',
    name: 'Pro',
    description: '대규모 조직을 위한 프리미엄 플랜',
    monthly: { price: '$149', productId: SANDBOX_PRODUCTS.pro_monthly },
    yearly: { price: '$1,490', productId: SANDBOX_PRODUCTS.pro_yearly, savings: '17% 절약' },
    features: ['무제한 스프린트', '무제한 멤버', 'AI 에이전트 우선순위', 'BYOM 지원', '전담 지원'],
    highlighted: true,
  },
];

export default function UpgradePage() {
  const [billing, setBilling] = useState<'monthly' | 'yearly'>('monthly');
  const [loading, setLoading] = useState<string | null>(null);

  async function handleCheckout(productId: string) {
    setLoading(productId);
    try {
      const res = await fetch('/api/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ product_id: productId }),
      });
      const data = await res.json();
      if (!res.ok || !data.data?.url) {
        console.error('Checkout failed', data);
        setLoading(null);
        return;
      }

      const { PolarEmbedCheckout } = await import('@polar-sh/checkout/embed');
      const embed = await PolarEmbedCheckout.create(data.data.url);
      embed.addEventListener('success', () => setLoading(null));
      embed.addEventListener('close', () => setLoading(null));
    } catch (err) {
      console.error('Checkout error', err);
      setLoading(null);
    }
  }

  return (
    <div className="mx-auto max-w-3xl px-4 py-12">
      <div className="mb-10 text-center">
        <h1 className="font-heading text-3xl font-bold">플랜 업그레이드</h1>
        <p className="mt-2 text-muted-foreground">팀의 규모에 맞는 플랜을 선택하세요.</p>

        <div className="mt-6 inline-flex items-center rounded-full border border-border bg-muted p-1">
          <button
            onClick={() => setBilling('monthly')}
            className={`rounded-full px-4 py-1.5 text-sm font-medium transition ${
              billing === 'monthly' ? 'bg-background shadow text-foreground' : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            월간
          </button>
          <button
            onClick={() => setBilling('yearly')}
            className={`rounded-full px-4 py-1.5 text-sm font-medium transition ${
              billing === 'yearly' ? 'bg-background shadow text-foreground' : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            연간
          </button>
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        {PLANS.map((plan) => {
          const tier = billing === 'monthly' ? plan.monthly : plan.yearly;
          const isLoading = loading === tier.productId;
          return (
            <Card
              key={plan.key}
              className={plan.highlighted ? 'border-primary ring-2 ring-primary/20' : ''}
            >
              <CardHeader>
                <div className="flex items-center justify-between">
                  <CardTitle>{plan.name}</CardTitle>
                  {plan.highlighted && (
                    <span className="rounded-full bg-primary/10 px-2.5 py-0.5 text-xs font-medium text-primary">
                      추천
                    </span>
                  )}
                </div>
                <CardDescription>{plan.description}</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div>
                  <span className="text-3xl font-bold">{tier.price}</span>
                  <span className="ml-1 text-sm text-muted-foreground">
                    /{billing === 'monthly' ? '월' : '년'}
                  </span>
                  {'savings' in tier && (
                    <span className="ml-2 text-xs text-emerald-600 dark:text-emerald-400">
                      {tier.savings}
                    </span>
                  )}
                </div>
                <ul className="space-y-2 text-sm text-muted-foreground">
                  {plan.features.map((f) => (
                    <li key={f} className="flex items-center gap-2">
                      <span className="text-primary">✓</span>
                      {f}
                    </li>
                  ))}
                </ul>
                <Button
                  className="w-full"
                  variant={plan.highlighted ? 'default' : 'outline'}
                  disabled={isLoading}
                  onClick={() => handleCheckout(tier.productId)}
                >
                  {isLoading ? '처리 중...' : `${plan.name} 시작하기`}
                </Button>
              </CardContent>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
