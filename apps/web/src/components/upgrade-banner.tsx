'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';

interface UsageData {
  tier: string;
  usage: Record<string, number>;
  quotas: Record<string, number>;
}

const RESOURCE_LABELS: Record<string, string> = {
  stories: '스토리',
  memos: '메모',
  docs: '문서',
  api_calls: 'API 호출',
};

const DISMISS_KEY = 'upgrade-banner-dismissed';

function getHighestUsagePercent(data: UsageData): { resource: string; percent: number; current: number; limit: number } | null {
  const monthly = ['stories', 'memos', 'api_calls'] as const;
  let highest: { resource: string; percent: number; current: number; limit: number } | null = null;

  for (const r of monthly) {
    const limit = data.quotas[r] ?? 0;
    if (limit >= 999_999_999) continue;
    const current = data.usage[r] ?? 0;
    const percent = limit > 0 ? Math.round((current / limit) * 100) : 0;
    if (percent >= 80 && (!highest || percent > highest.percent)) {
      highest = { resource: r, percent, current, limit };
    }
  }
  return highest;
}

export function UpgradeBanner() {
  const [alert, setAlert] = useState<{ resource: string; percent: number; current: number; limit: number } | null>(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    if (sessionStorage.getItem(DISMISS_KEY)) {
      setDismissed(true);
      return;
    }
    fetch('/api/usage')
      .then((r) => r.json())
      .then((body) => {
        if (body?.data) setAlert(getHighestUsagePercent(body.data));
      })
      .catch(() => {});
  }, []);

  function dismiss() {
    sessionStorage.setItem(DISMISS_KEY, '1');
    setDismissed(true);
  }

  if (dismissed || !alert) return null;

  return (
    <div className="flex items-center justify-between gap-3 bg-amber-500/10 px-4 py-2.5 text-sm text-amber-700 dark:bg-amber-500/15 dark:text-amber-400">
      <span>
        <strong>{RESOURCE_LABELS[alert.resource] ?? alert.resource}</strong>를{' '}
        {alert.current}/{alert.limit}개 사용 중 ({alert.percent}%) —{' '}
        <Link href="/upgrade" className="font-medium underline underline-offset-2">
          Team으로 업그레이드
        </Link>
        하면 {alert.percent >= 100 ? '계속 사용할 수 있습니다.' : '한도를 대폭 늘릴 수 있습니다.'}
      </span>
      <button
        onClick={dismiss}
        aria-label="배너 닫기"
        className="shrink-0 rounded p-0.5 hover:bg-amber-500/20"
      >
        ✕
      </button>
    </div>
  );
}
