'use client';

import { useState } from 'react';
import Link from 'next/link';

const UNLIMITED = 999_999_999;

const TIER_LABELS: Record<string, string> = {
  free: 'Free',
  team: 'Team',
  pro: 'Pro',
};

const RESOURCE_LABELS: Record<string, string> = {
  stories: 'Stories',
  memos: 'Memos',
  api_calls: 'API Calls',
};

interface UsageBarProps {
  label: string;
  current: number;
  limit: number;
}

function UsageBar({ label, current, limit }: UsageBarProps) {
  if (limit >= UNLIMITED) {
    return (
      <div className="flex items-center justify-between text-sm">
        <span className="text-muted-foreground">{label}</span>
        <span className="font-medium">{current.toLocaleString()} / Unlimited</span>
      </div>
    );
  }
  const pct = limit > 0 ? Math.min(Math.round((current / limit) * 100), 100) : 0;
  const barColor = pct >= 100 ? 'bg-red-500' : pct >= 80 ? 'bg-amber-500' : 'bg-primary';
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-sm">
        <span className="text-muted-foreground">{label}</span>
        <span className="font-medium">
          {current.toLocaleString()} / {limit.toLocaleString()} ({pct}%)
        </span>
      </div>
      <div className="h-1.5 w-full rounded-full bg-muted">
        <div className={`h-full rounded-full transition-all ${barColor}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

interface BillingSectionProps {
  tier: string;
  usage: Record<string, number>;
  quotas: Record<string, number>;
}

export function BillingSection({ tier, usage, quotas }: BillingSectionProps) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isFree = tier === 'free';

  async function handleManage() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/billing/portal', { method: 'POST' });
      const data = await res.json();
      if (!res.ok || !data.data?.url) {
        setError('Failed to open billing portal. Please try again.');
        return;
      }
      window.open(data.data.url, '_blank', 'noopener,noreferrer');
    } catch {
      setError('Network error. Please try again.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-6">
      {/* Current Plan */}
      <div className="rounded-lg border bg-card p-5">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Current Plan</p>
            <p className="mt-1 text-2xl font-bold">{TIER_LABELS[tier] ?? tier}</p>
          </div>
          {isFree ? (
            <Link
              href="/upgrade"
              className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
            >
              Upgrade
            </Link>
          ) : (
            <button
              onClick={handleManage}
              disabled={loading}
              className="rounded-lg border px-4 py-2 text-sm font-medium hover:bg-muted disabled:opacity-50"
            >
              {loading ? 'Opening…' : 'Manage Subscription'}
            </button>
          )}
        </div>
        {error && <p className="mt-3 text-xs text-destructive">{error}</p>}
      </div>

      {/* Usage */}
      <div className="rounded-lg border bg-card p-5">
        <p className="mb-4 text-sm font-semibold">This Month's Usage</p>
        <div className="space-y-4">
          {(['stories', 'memos', 'api_calls'] as const).map((r) => (
            <UsageBar
              key={r}
              label={RESOURCE_LABELS[r] ?? r}
              current={usage[r] ?? 0}
              limit={quotas[r] ?? 0}
            />
          ))}
        </div>
      </div>

      {/* Upgrade CTA for free tier */}
      {isFree && (
        <div className="rounded-lg border-2 border-primary/20 bg-primary/5 p-5 text-center">
          <p className="mb-1 text-sm font-semibold">Need more capacity?</p>
          <p className="mb-4 text-xs text-muted-foreground">
            Upgrade to Team for 10× higher limits, or Pro for unlimited usage.
          </p>
          <Link
            href="/upgrade"
            className="inline-block rounded-lg bg-primary px-6 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
          >
            View Plans
          </Link>
        </div>
      )}
    </div>
  );
}
