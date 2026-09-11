'use client';

import { useEffect, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { fetchWithAuth } from '@/lib/db/client';
import { formatMinorCurrency, type GenerationBudgetCurrency } from '@/components/content/generation-budget-indicator';
import { formatScheduledAt, resolveDisplayTimezone } from '@/components/content/schedule-format';

// story #3806(Phase3·3-2 PR5, 유나 §절 §2 「중지 스위치」) — 실행 중인 홍보의 중지/재개.
// 자리 = 상세(이 컴포넌트, gates/[id]/page.tsx에서 마운트)·성과 보드 행(조각⑥, 같은
// 컴포넌트 재사용 예정).
//
// 「홍보 시작」 트리거 — 페드루 PO 콜①(2026-09-11 11:47Z, 그라운딩 회신): 카드 AC2가
// 「[제품] 상한 내 실행」이라 원래 설계는 승인 뒤 봉인 starts_at에 BE 스케줄러가
// 자동 실행하는 것이지만, PR3에 그 자동발화가 0건(grep 확認)이라 «승인만 하고 아무것도
// 안 도는» 화면을 첫 출시에 낼 수 없어 사람 클릭을 **지름길**로 이번 PR에 얹는다 —
// 목표(자동 실행)는 후속 조각(BE 스케줄러) 몫으로 남는다. starts_at 이전엔 버튼을
// 비활성 + 사유 문구로(서버가 그 축을 검사하지 않아 클라에서 막는다, 그라운딩 확認).
//
// run_status 원천은 /spend(조각⑤ 착수 前 자체발견 fix로 신설) — 새 GET 신설 안 함.

export interface BoostExecutionControlProps {
  orgId: string;
  gateId: string;
  sealedAdsBudgetMinor: number | null;
  sealedAdsCurrency: string | null;
  sealedAdsStartsAt: string | null;
  sealedAdsEndsAt: string | null;
  sealedAdsObjective: string | null;
}

type RunStatus = 'pending' | 'running' | 'paused' | 'failed';

export function BoostExecutionControl({
  orgId, gateId, sealedAdsBudgetMinor, sealedAdsCurrency, sealedAdsStartsAt, sealedAdsEndsAt, sealedAdsObjective,
}: BoostExecutionControlProps) {
  const t = useTranslations('cage');
  const tContent = useTranslations('content');
  const locale = useLocale();
  const displayTimezone = resolveDisplayTimezone().tz;
  const [runStatus, setRunStatus] = useState<RunStatus | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [startConfirmOpen, setStartConfirmOpen] = useState(false);
  const [pauseConfirmOpen, setPauseConfirmOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const load = () => {
    fetchWithAuth(`/api/organizations/${orgId}/ads-boosts/${gateId}/spend`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`status ${r.status}`))))
      .then((json: { data?: { run_status: RunStatus | null } }) => {
        setRunStatus(json.data?.run_status ?? null);
        setLoaded(true);
      })
      .catch(() => setLoaded(true));
  };

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { load(); }, [orgId, gateId]);

  const doAction = async (operation: 'start' | 'pause' | 'resume', onDone: () => void) => {
    setSubmitting(true);
    setActionError(null);
    try {
      const res = await fetchWithAuth(`/api/organizations/${orgId}/ads-boosts/${gateId}/${operation}`, { method: 'POST' });
      if (!res.ok) {
        setActionError(t('boostExecutionActionError'));
        return;
      }
      onDone();
      load();
    } catch {
      setActionError(t('boostExecutionActionError'));
    } finally {
      setSubmitting(false);
    }
  };

  if (!loaded) return null;

  if (runStatus !== 'running' && runStatus !== 'paused') {
    // 아직 시작 前(run_status=null·pending·failed는 이 조각에선 미시작과 동형 취급 —
    // failed 재시도는 범위 밖). starts_at 자체가 없으면(그라운딩 갭 — 이론상 불가,
    // 봉인 5필드 필수) 버튼을 안 그린다(지어내지 않는다).
    if (!sealedAdsStartsAt) return null;
    const startsAtMs = new Date(sealedAdsStartsAt).getTime();
    const beforeStart = startsAtMs > Date.now();
    return (
      <div className="space-y-2" data-testid="boost-execution-control">
        {actionError ? <p className="text-xs text-destructive" data-testid="boost-execution-error">{actionError}</p> : null}
        <Button
          variant="outline" size="sm" disabled={beforeStart}
          onClick={() => setStartConfirmOpen(true)} data-testid="boost-start-trigger"
        >
          {t('boostExecutionStart')}
        </Button>
        {beforeStart ? (
          <p className="text-xs text-muted-foreground" data-testid="boost-start-before-schedule">
            {t('boostExecutionStartBeforeSchedule', { date: formatScheduledAt(sealedAdsStartsAt, displayTimezone).display })}
          </p>
        ) : null}

        <Dialog open={startConfirmOpen} onOpenChange={setStartConfirmOpen}>
          <DialogContent data-testid="boost-start-confirm-dialog">
            <DialogHeader>
              <DialogTitle>{t('boostExecutionStartConfirmTitle')}</DialogTitle>
              <DialogDescription>{t('boostExecutionStartConfirmDescription')}</DialogDescription>
            </DialogHeader>
            {/* 봉인 3값 그대로 재확인(페드루 PO 콜①) — RecipeApprovalFactsBlock과 같은
                포맷터 재사용(formatMinorCurrency·formatScheduledAt), 새 표시 로직 0. */}
            <div className="space-y-1 rounded-lg bg-muted/40 px-2.5 py-1.5 text-[11.5px]">
              <p>
                <span className="text-muted-foreground">{t('adsBoostBudgetLabel')} · </span>
                <span className="text-foreground font-medium">
                  {sealedAdsBudgetMinor !== null && sealedAdsCurrency
                    ? formatMinorCurrency(sealedAdsBudgetMinor, sealedAdsCurrency as GenerationBudgetCurrency, locale, tContent)
                    : null}
                </span>
              </p>
              {sealedAdsStartsAt && sealedAdsEndsAt ? (
                <p>
                  <span className="text-muted-foreground">{t('adsBoostScheduleLabel')} · </span>
                  <span className="text-foreground">
                    {formatScheduledAt(sealedAdsStartsAt, displayTimezone).display}
                    {' ~ '}
                    {formatScheduledAt(sealedAdsEndsAt, displayTimezone).display}
                  </span>
                </p>
              ) : null}
              {sealedAdsObjective ? (
                <p>
                  <span className="text-muted-foreground">{t('adsBoostObjectiveLabel')} · </span>
                  <span className="text-foreground">{sealedAdsObjective}</span>
                </p>
              ) : null}
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setStartConfirmOpen(false)} disabled={submitting}>
                {t('boostExecutionCancel')}
              </Button>
              <Button
                onClick={() => void doAction('start', () => setStartConfirmOpen(false))}
                disabled={submitting} data-testid="boost-start-confirm"
              >
                {submitting ? t('boostExecutionStarting') : t('boostExecutionStartConfirm')}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    );
  }

  return (
    <div className="space-y-2" data-testid="boost-execution-control">
      <p className="text-xs">
        <span className="font-medium text-foreground">
          {runStatus === 'running' ? t('boostExecutionStatusRunning') : t('boostExecutionStatusPaused')}
        </span>
      </p>
      {actionError ? <p className="text-xs text-destructive" data-testid="boost-execution-error">{actionError}</p> : null}
      {runStatus === 'running' ? (
        <Button variant="outline" size="sm" onClick={() => setPauseConfirmOpen(true)} data-testid="boost-pause-trigger">
          {t('boostExecutionPause')}
        </Button>
      ) : (
        <Button
          variant="outline" size="sm" disabled={submitting}
          onClick={() => void doAction('resume', () => {})} data-testid="boost-resume-trigger"
        >
          {submitting ? t('boostExecutionResuming') : t('boostExecutionResume')}
        </Button>
      )}

      {/* story #3806(유나 §절 §2 「비용 명확」) — 확認 다이얼로그 문구는 §절 원문 그대로. */}
      <Dialog open={pauseConfirmOpen} onOpenChange={setPauseConfirmOpen}>
        <DialogContent data-testid="boost-pause-confirm-dialog">
          <DialogHeader>
            <DialogTitle>{t('boostExecutionPauseConfirmTitle')}</DialogTitle>
            <DialogDescription>{t('boostExecutionPauseConfirmDescription')}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPauseConfirmOpen(false)} disabled={submitting}>
              {t('boostExecutionCancel')}
            </Button>
            <Button
              onClick={() => void doAction('pause', () => setPauseConfirmOpen(false))}
              disabled={submitting} data-testid="boost-pause-confirm"
            >
              {submitting ? t('boostExecutionPausing') : t('boostExecutionPauseConfirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
