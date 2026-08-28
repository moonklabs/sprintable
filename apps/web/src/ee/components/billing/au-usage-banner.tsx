'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { AlertOctagon, AlertTriangle, X } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { useDashboardContext } from '@/app/dashboard/dashboard-shell';
import { fetchWithAuth } from '@/lib/db/client';
import { isEEEnabled } from '@/lib/ee';

/** 세션 한정 dismiss 키 — warning(80/90%)만 사용. paused는 non-dismissible.
 * storage-capacity-banner.tsx와 달리 «어느 밴드를 dismiss했는지»를 저장(값='80'|'90')한다 —
 * PO 집행세칙①(2026-08-28): 80→90 승급이나 해소 후 재크로싱이면 재등장해야 한다(단순
 * boolean 플래그는 승급을 못 구분). 저장된 밴드가 현재 밴드와 정확히 같을 때만 숨긴다. */
const WARN_DISMISS_KEY = 'au-usage-warn-dismissed-band';

type Band = 'none' | '80' | '90' | 'paused';

interface AuUsage {
  current: number;
  limit: number | null;
  paused: boolean;
  canManage: boolean;
}

/**
 * story #3190(결제②-C 후속·FE) — AU(automation_units) 80/90%·paused 제품내 경고.
 * `/api/billing/status`(ee/routers/billing.py::get_billing_status가 확장한 au_current/
 * au_limit/au_paused/can_manage)를 마운트 시 1회(no-polling) 조회. pct는 storage-capacity-
 * banner와 동형으로 FE가 current/limit에서 직접 계산(크론의 au_warn_80/90_notified_at은
 * 메일-dedup 전용 마커라 표시 판정에 재사용하지 않는다 — PO 확定, ee/routers/billing.py 주석 참고).
 *   - paused(100%+유예 초과) → block(red)·non-dismissible·402 문구와 정합
 *   - 90%+  → warning(amber)·강조 문구(메일 기수신 안내)·세션 dismiss 가능
 *   - 80%+  → warning(amber)·세션 dismiss 가능
 *   - <80% 또는 관리자 아님 또는 fetch 실패 → 아무것도 렌더하지 않음.
 * ⛔story #3190 PO 지시(페드루, 2026-08-28) — 이 배너는 관리자(owner/admin) 대상 한정.
 * storage-capacity-banner(전 구성원 노출+CTA만 role-gate)와 달리 가시성 자체를 role로 막는다.
 */
export function AuUsageBanner() {
  const t = useTranslations('billing');
  const router = useRouter();
  const { orgId } = useDashboardContext();

  const [usage, setUsage] = useState<AuUsage | null>(null);
  const [dismissedBand, setDismissedBand] = useState<Band | null>(() => {
    if (typeof window === 'undefined') return null;
    try {
      return (sessionStorage.getItem(WARN_DISMISS_KEY) as Band | null) ?? null;
    } catch {
      return null;
    }
  });

  useEffect(() => {
    // AU billing 엔드포인트 자체가 EE 전용 라우터(ee/routers/billing.py, EE_ENABLED 아니면
    // main.py가 아예 등록 안 함) — OSS 빌드에서 fetch하면 항상 403이라 시도 자체를 건너뛴다.
    if (!isEEEnabled()) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetchWithAuth('/api/billing/status');
        if (!res.ok) return;
        const json = (await res.json()) as {
          data?: {
            au_current?: number;
            au_limit?: number | null;
            au_paused?: boolean;
            can_manage?: boolean;
          };
        };
        const d = json.data;
        if (!d || cancelled) return;
        setUsage({
          current: d.au_current ?? 0,
          limit: typeof d.au_limit === 'number' ? d.au_limit : null,
          paused: d.au_paused ?? false,
          canManage: d.can_manage ?? false,
        });
      } catch {
        // 조회 실패는 치명적이지 않음 — 배너 미노출(에러 표면 없음)
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [orgId]);

  // 해소 후 재크로싱(PO 집행세칙①) — 80/90 밴드에서 벗어난 조회 결과를 받으면 저장된
  // dismiss를 지워 재무장한다. 안 지우면 "80%에서 dismiss→해소→재크로싱" 시 남아있던
  // dismissedBand==='80'이 새로 진입한 '80' 밴드와 우연히 같아 조용히 계속 숨는다.
  useEffect(() => {
    if (!usage) return;
    const pct = usage.limit && usage.limit > 0 ? (usage.current / usage.limit) * 100 : 0;
    const resolvedBand: Band = usage.paused ? 'paused' : pct >= 90 ? '90' : pct >= 80 ? '80' : 'none';
    if (resolvedBand === 'none' && dismissedBand !== null) {
      try {
        sessionStorage.removeItem(WARN_DISMISS_KEY);
      } catch {
        // 영속 실패 무시 — 아래 setDismissedBand(null)로 이번 세션 메모리 상태는 정리됨
      }
      setDismissedBand(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [usage]);

  if (!usage || !usage.canManage) return null;

  // limit 미정의(무제한/미시드 tier) → div0 방어 겸 미노출.
  const pct = usage.limit && usage.limit > 0 ? (usage.current / usage.limit) * 100 : 0;
  const band: Band = usage.paused ? 'paused' : pct >= 90 ? '90' : pct >= 80 ? '80' : 'none';

  if (band === 'none') return null;
  // paused는 항상 노출(non-dismissible, PO 집행세칙①). 80/90은 저장된 밴드가 현재
  // 밴드와 정확히 같을 때만 숨긴다 — 80→90 승급이면 dismissedBand('80')≠band('90')라
  // 재등장한다(단순 boolean이었다면 이 재등장이 안 됨).
  if (band !== 'paused' && dismissedBand === band) return null;

  const roundedPct = Math.round(pct);
  const isPaused = band === 'paused';
  const isStrong = band === '90';
  const title = isPaused ? t('auPausedTitle') : isStrong ? t('auWarn90Title', { pct: roundedPct }) : t('auWarnTitle', { pct: roundedPct });
  const desc = isPaused ? t('auPausedDesc') : isStrong ? t('auWarn90Desc') : t('auWarnDesc');

  const handleDismiss = () => {
    try {
      sessionStorage.setItem(WARN_DISMISS_KEY, band);
    } catch {
      // 영속 실패해도 이번 렌더에선 숨김 처리
    }
    setDismissedBand(band);
  };

  return (
    <Alert variant={isPaused ? 'destructive' : 'warning'}>
      {isPaused ? <AlertOctagon className="size-4 text-destructive" /> : <AlertTriangle className="size-4" />}
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription>{desc}</AlertDescription>

      {usage.limit != null && (
        <div className="col-start-2 mt-2">
          <div
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={roundedPct}
            aria-label={`${usage.current} / ${usage.limit} AU · ${roundedPct}%`}
            className="h-1.5 w-full overflow-hidden rounded-full bg-muted"
          >
            <div
              className={`h-full rounded-full ${isPaused ? 'bg-destructive' : 'bg-warning'}`}
              style={{ width: `${Math.min(100, pct)}%` }}
            />
          </div>
          <p className="mt-1.5 text-xs text-muted-foreground">
            {t.rich('auUsage', {
              used: usage.current,
              limit: usage.limit,
              pct: roundedPct,
              b: (chunks) => <b className="font-semibold text-foreground">{chunks}</b>,
            })}
          </p>
        </div>
      )}

      <div className="col-start-2 mt-2 flex flex-wrap gap-2">
        <Button size="sm" variant="default" onClick={() => router.push('/settings?tab=billing')}>
          {t('auUpgrade')}
        </Button>
      </div>

      {!isPaused && (
        <Button
          variant="ghost"
          size="icon-sm"
          className="absolute right-2 top-2"
          aria-label={t('auDismiss')}
          onClick={handleDismiss}
        >
          <X className="size-4" />
        </Button>
      )}
    </Alert>
  );
}
