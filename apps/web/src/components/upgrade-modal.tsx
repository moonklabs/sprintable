'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';

interface QuotaExceededDetail {
  resource: string;
  current: number;
  limit: number;
  upgradeUrl?: string;
}

const RESOURCE_LABELS: Record<string, string> = {
  stories: '스토리',
  memos: '메모',
  docs: '문서',
  members: '팀 멤버',
  projects: '프로젝트',
  api_calls: 'API 호출',
};

export function UpgradeModal() {
  const router = useRouter();
  const [detail, setDetail] = useState<QuotaExceededDetail | null>(null);

  useEffect(() => {
    function handler(e: Event) {
      const d = (e as CustomEvent<QuotaExceededDetail>).detail;
      setDetail(d);
    }
    window.addEventListener('quota-exceeded', handler);
    return () => window.removeEventListener('quota-exceeded', handler);
  }, []);

  if (!detail) return null;

  const label = RESOURCE_LABELS[detail.resource] ?? detail.resource;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4 backdrop-blur-sm" role="dialog" aria-modal="true">
      <div className="w-full max-w-sm rounded-2xl border border-border bg-card p-6 shadow-xl">
        <h2 className="font-heading text-lg font-semibold">쿼터 초과</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          <strong>{label}</strong> 한도({detail.limit}개)에 도달했습니다.
          현재 {detail.current}개 사용 중입니다.
        </p>
        <p className="mt-1 text-sm text-muted-foreground">
          Team 또는 Pro 플랜으로 업그레이드하면 한도가 대폭 늘어납니다.
        </p>
        <div className="mt-5 flex gap-2">
          <Button
            className="flex-1"
            onClick={() => {
              setDetail(null);
              router.push('/upgrade');
            }}
          >
            업그레이드
          </Button>
          <Button variant="outline" className="flex-1" onClick={() => setDetail(null)}>
            닫기
          </Button>
        </div>
      </div>
    </div>
  );
}

/** Call this from any API error handler when a 402 quota_exceeded is received. */
export function dispatchQuotaExceeded(detail: QuotaExceededDetail) {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent('quota-exceeded', { detail }));
}
