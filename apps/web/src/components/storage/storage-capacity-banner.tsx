'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { AlertOctagon, AlertTriangle, X } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { useDashboardContext } from '@/app/dashboard/dashboard-shell';
import { isEEEnabled } from '@/lib/ee';
import { formatStorageSize } from '@/lib/storage/format';
import { cn } from '@/lib/utils';

/** 세션 한정 dismiss 키 — warning 배너만 사용. 다음 세션에도 ≥80%면 재노출(영구 숨김 금지). */
const WARN_DISMISS_KEY = 'storage-capacity-warn-dismissed';

interface StorageUsage {
  used: number;
  limit: number;
  pct: number;
}

/**
 * S8 — 스토리지 용량 경고 배너 (story 4fbb10c1).
 * `/api/assets/storage-usage` 를 마운트 시 1회(no-polling) 조회해 2-심각도로 노출:
 *   - 80–99% → warning(amber)·세션 dismiss 가능(sessionStorage)·다음 세션 재노출
 *   - 100%+  → block(red)·non-dismissible(실 차단 상태 은폐 방지)
 * <80% 또는 fetch 실패 → 아무것도 렌더하지 않음(graceful, 에러 표면 없음).
 * 색상은 Alert variant + bg-warning/bg-destructive 토큰만 사용(하드코딩 금지·양 테마 대응).
 */
export function StorageCapacityBanner() {
  const t = useTranslations('storage');
  const router = useRouter();
  const { orgId, orgMemberships } = useDashboardContext();

  const [usage, setUsage] = useState<StorageUsage | null>(null);
  // 세션 dismiss 플래그 복원(이번 세션 한정) — lazy initializer.
  // 배너는 usage 로드(클라이언트) 전엔 null 렌더라 SSR/hydration 불일치 없음.
  const [dismissed, setDismissed] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    try {
      return sessionStorage.getItem(WARN_DISMISS_KEY) === '1';
    } catch {
      // sessionStorage 접근 불가 환경 — dismiss 비활성(배너 노출 유지)
      return false;
    }
  });

  // 마운트 1회 조회(폴링 없음·취소 안전).
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch('/api/assets/storage-usage');
        if (!res.ok) return;
        const json = (await res.json()) as {
          data?: { used_bytes?: number; limit_bytes?: number; percentage?: number };
        };
        const d = json.data;
        // percentage 가 유한수일 때만 채택 — limit_bytes 0/null(무제한·OSS) → BE 가 NaN/Infinity/null
        // 줄 수 있고, NaN < 80 은 false 라 가드 없으면 깨진(NaN%) 배너가 렌더된다(div0 방어).
        if (!d || !Number.isFinite(d.percentage)) return;
        if (cancelled) return;
        setUsage({
          used: d.used_bytes ?? 0,
          limit: d.limit_bytes ?? 0,
          pct: d.percentage,
        });
      } catch {
        // 조회 실패는 치명적이지 않음 — 배너 미노출(에러 표면 없음)
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // <80% 또는 미조회 → 미노출.
  if (!usage || usage.pct < 80) return null;

  const isBlock = usage.pct >= 100;
  // warning 만 세션 dismiss 적용·block 은 항상 노출(non-dismissible).
  if (!isBlock && dismissed) return null;

  const role = orgMemberships.find((o) => o.orgId === orgId)?.role;
  const canManage = role === 'owner' || role === 'admin';
  // 업그레이드 CTA = 권한(owner/admin) + billing 탭 EE 게이트 모두 충족 시에만.
  const showUpgrade = canManage && isEEEnabled();

  const roundedPct = Math.round(usage.pct);
  const title = isBlock ? t('capacityBlockTitle') : t('capacityWarnTitle');
  const desc = isBlock
    ? t('capacityBlockDesc')
    : canManage
      ? t('capacityWarnDesc', { pct: roundedPct })
      : t('capacityWarnDescNoManage', { pct: roundedPct });

  const handleDismiss = () => {
    try {
      sessionStorage.setItem(WARN_DISMISS_KEY, '1');
    } catch {
      // 영속 실패해도 이번 렌더에선 숨김 처리
    }
    setDismissed(true);
  };

  return (
    <Alert variant={isBlock ? 'destructive' : 'warning'}>
      {isBlock ? <AlertOctagon className="size-4" /> : <AlertTriangle className="size-4" />}
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription>{desc}</AlertDescription>

      {/* 사용량 바 */}
      <div className="col-start-2 mt-2">
        <div
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={roundedPct}
          aria-label={`${formatStorageSize(usage.used)} / ${formatStorageSize(usage.limit)} · ${roundedPct}%`}
          className="h-1.5 w-full overflow-hidden rounded-full bg-muted"
        >
          <div
            className={cn('h-full rounded-full', isBlock ? 'bg-destructive' : 'bg-warning')}
            style={{ width: `${Math.min(100, usage.pct)}%` }}
          />
        </div>
        <p className="mt-1.5 text-xs text-muted-foreground">
          {t.rich('capacityUsage', {
            used: formatStorageSize(usage.used),
            limit: formatStorageSize(usage.limit),
            pct: roundedPct,
            b: (chunks) => <b className="font-semibold text-foreground">{chunks}</b>,
          })}
        </p>
      </div>

      {/* CTA — 파일 관리는 block 상태에서도 primary(red-on-red 금지) */}
      <div className="col-start-2 mt-2 flex flex-wrap gap-2">
        <Button size="sm" variant="default" onClick={() => router.push('/storage')}>
          {t('capacityManageFiles')}
        </Button>
        {showUpgrade && (
          <Button size="sm" variant="outline" onClick={() => router.push('/settings?tab=billing')}>
            {t('capacityUpgrade')}
          </Button>
        )}
      </div>

      {/* 세션 dismiss — warning 만. block 은 dismiss 없음. */}
      {!isBlock && (
        <Button
          variant="ghost"
          size="icon-sm"
          className="absolute right-2 top-2"
          aria-label={t('capacityDismiss')}
          onClick={handleDismiss}
        >
          <X className="size-4" />
        </Button>
      )}
    </Alert>
  );
}
