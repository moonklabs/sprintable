'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { fetchWithAuth } from '@/lib/db/client';
import { majorToMinor, type GenerationBudgetCurrency } from '@/components/content/generation-budget-indicator';
import { validateScheduledAt } from '@/components/content/validate-scheduled-at';

// story #3806(Phase3·3-2 PR5, 유나 §절 §1 「발행물에서 boost 요청 폼」) — 승인된
// 발행물에서 Meta Ads 「홍보」 요청. Dialog+datetime-local 배선은
// schedule-at-dialog.tsx(story #3422)와 동형(새 기전 발명 0) — validateScheduledAt도
// 그대로 재사용(과거 시각·naive 값 거부 규칙이 starts_at/ends_at 둘 다에 동일하게
// 적용된다, BE _scheduled_at_must_be_tz_aware_future와 별개 축이지만 판단 로직은
// «미래 시각 필수»로 같다).

interface AdConnectionOption {
  id: string;
  channel: string;
  account_label: string | null;
  account_id: string;
  status: string;
}

// PO 追加 確定(2026-09-11, 카드 그라운딩 ②) — boost 대상 광고 계정은 이 두 채널만
// (meta_ads=실 계정·ads_sandbox=dev 미러, facebook_sandbox 동형).
const AD_CONNECTION_CHANNELS = new Set(['meta_ads', 'ads_sandbox']);

// 그라운딩①(카드, 「미확認 표기」) — Meta Marketing API objective 전체 스펙은
// 미확認. 자유 텍스트 입력 대신 문서 예시(creative reference)로 실측된 값만
// select로 제시해 오타발 422를 막는다 — 새 값이 필요해지면 이 배열에 추가.
const OBJECTIVE_OPTIONS = ['POST_ENGAGEMENT', 'REACH', 'LINK_CLICKS'] as const;

const ERROR_MESSAGE_KEYS: Record<string, string> = {
  ADS_BOOST_INVALID_AD_CONNECTION: 'boostRequestErrorInvalidAdConnection',
  ADS_BOOST_APPROVER_ROLE_MISSING: 'boostRequestErrorApproverRoleMissing',
  ADS_BUDGET_EXCEEDS_SEAL: 'boostRequestErrorBudgetExceedsSeal',
  ADS_BOOST_INVALID_SCHEDULE: 'boostRequestErrorInvalidSchedule',
  ADS_BOOST_PUBLICATION_NOT_FOUND: 'boostRequestErrorPublicationNotFound',
};

export interface BoostRequestDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  orgId: string;
  publicationId: string;
  onRequested?: () => void;
}

export function BoostRequestDialog({ open, onOpenChange, orgId, publicationId, onRequested }: BoostRequestDialogProps) {
  const t = useTranslations('content');
  const [connections, setConnections] = useState<AdConnectionOption[] | null>(null);
  const [adConnectionId, setAdConnectionId] = useState('');
  const [budgetMajor, setBudgetMajor] = useState('');
  const [currency, setCurrency] = useState<GenerationBudgetCurrency>('KRW');
  const [startsAtLocal, setStartsAtLocal] = useState('');
  const [endsAtLocal, setEndsAtLocal] = useState('');
  const [objective, setObjective] = useState<string>(OBJECTIVE_OPTIONS[0]);
  const [touched, setTouched] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setConnections(null);
    fetchWithAuth(`/api/organizations/${orgId}/channel-connections`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`status ${r.status}`))))
      .then((json: { data?: AdConnectionOption[] }) => {
        const rows = json.data ?? [];
        setConnections(rows.filter((c) => AD_CONNECTION_CHANNELS.has(c.channel) && c.status === 'active'));
      })
      .catch(() => setConnections([]));
  }, [open, orgId]);

  const startsAtValidation = validateScheduledAt(startsAtLocal);
  const endsAtValidation = validateScheduledAt(endsAtLocal);
  const scheduleOrderValid = startsAtValidation.valid && endsAtValidation.valid
    && new Date(endsAtValidation.iso).getTime() > new Date(startsAtValidation.iso).getTime();
  const budgetMajorNumber = Number(budgetMajor);
  const budgetValid = budgetMajor !== '' && Number.isFinite(budgetMajorNumber) && budgetMajorNumber > 0;
  const formValid = Boolean(adConnectionId) && budgetValid
    && startsAtValidation.valid && endsAtValidation.valid && scheduleOrderValid;

  const handleSubmit = async () => {
    setTouched(true);
    if (!formValid || !startsAtValidation.valid || !endsAtValidation.valid) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const res = await fetchWithAuth(`/api/organizations/${orgId}/publications/${publicationId}/boosts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ad_connection_id: adConnectionId,
          budget_minor: majorToMinor(budgetMajorNumber, currency),
          currency,
          starts_at: startsAtValidation.iso,
          ends_at: endsAtValidation.iso,
          objective,
        }),
      });
      if (!res.ok) {
        // story #3601 관례 그대로 — .error를 1순위(BE 전역 봉투 {data,error,meta}),
        // .detail은 무해한 방어적 폴백만.
        const body = await res.json().catch(() => null) as
          { error?: { code?: string }; detail?: { code?: string } } | null;
        const code = body?.error?.code ?? body?.detail?.code;
        setSubmitError(code && ERROR_MESSAGE_KEYS[code] ? t(ERROR_MESSAGE_KEYS[code]) : t('boostRequestErrorGeneric'));
        return;
      }
      onOpenChange(false);
      onRequested?.();
    } catch {
      setSubmitError(t('boostRequestErrorGeneric'));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="boost-request-dialog">
        <DialogHeader>
          <DialogTitle>{t('boostRequestDialogTitle')}</DialogTitle>
          <DialogDescription>{t('boostRequestDialogDescription')}</DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground" htmlFor="boost-ad-connection">
              {t('boostRequestAdConnectionLabel')}
            </label>
            {connections === null ? (
              <p className="text-xs text-muted-foreground">{t('boostRequestAdConnectionLoading')}</p>
            ) : connections.length === 0 ? (
              <p className="text-xs text-muted-foreground" data-testid="boost-no-ad-connection">
                {t('boostRequestNoAdConnection')}
              </p>
            ) : (
              <select
                id="boost-ad-connection"
                value={adConnectionId}
                onChange={(e) => setAdConnectionId(e.target.value)}
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                data-testid="boost-ad-connection-select"
              >
                <option value="">{t('boostRequestAdConnectionPlaceholder')}</option>
                {connections.map((c) => (
                  <option key={c.id} value={c.id}>{c.account_label ?? c.account_id}</option>
                ))}
              </select>
            )}
          </div>

          <div className="flex flex-wrap items-end gap-2">
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground" htmlFor="boost-budget">
                {t('boostRequestBudgetLabel')}
              </label>
              <input
                id="boost-budget" type="number" min={0} step={1}
                value={budgetMajor}
                onChange={(e) => setBudgetMajor(e.target.value)}
                className="w-32 rounded-md border border-input bg-background px-3 py-2 text-sm"
                data-testid="boost-budget-input"
              />
            </div>
            <select
              value={currency}
              onChange={(e) => setCurrency(e.target.value as GenerationBudgetCurrency)}
              className="rounded-md border border-input bg-background px-3 py-2 text-sm"
              data-testid="boost-currency-select"
            >
              <option value="KRW">KRW</option>
              <option value="USD">USD</option>
            </select>
          </div>
          {touched && !budgetValid ? (
            <p className="text-xs text-destructive" data-testid="boost-budget-error">{t('boostRequestBudgetError')}</p>
          ) : null}

          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground" htmlFor="boost-starts-at">
              {t('boostRequestStartsAtLabel')}
            </label>
            <input
              id="boost-starts-at" type="datetime-local"
              value={startsAtLocal}
              onChange={(e) => setStartsAtLocal(e.target.value)}
              className="rounded-md border border-input bg-background px-3 py-2 text-sm"
              data-testid="boost-starts-at-input"
            />
          </div>
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground" htmlFor="boost-ends-at">
              {t('boostRequestEndsAtLabel')}
            </label>
            <input
              id="boost-ends-at" type="datetime-local"
              value={endsAtLocal}
              onChange={(e) => setEndsAtLocal(e.target.value)}
              className="rounded-md border border-input bg-background px-3 py-2 text-sm"
              data-testid="boost-ends-at-input"
            />
          </div>
          {touched && (!startsAtValidation.valid || !endsAtValidation.valid) ? (
            <p className="text-xs text-destructive" data-testid="boost-schedule-error">{t('boostRequestScheduleInvalid')}</p>
          ) : touched && !scheduleOrderValid ? (
            <p className="text-xs text-destructive" data-testid="boost-schedule-order-error">{t('boostRequestScheduleOrderInvalid')}</p>
          ) : null}

          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground" htmlFor="boost-objective">
              {t('boostRequestObjectiveLabel')}
            </label>
            <select
              id="boost-objective"
              value={objective}
              onChange={(e) => setObjective(e.target.value)}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              data-testid="boost-objective-select"
            >
              {OBJECTIVE_OPTIONS.map((o) => (
                <option key={o} value={o}>{t(`boostObjective_${o}`)}</option>
              ))}
            </select>
          </div>
        </div>

        {submitError ? (
          <p className="text-xs text-destructive" data-testid="boost-submit-error">{submitError}</p>
        ) : null}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
            {t('boostRequestCancel')}
          </Button>
          <Button onClick={handleSubmit} disabled={submitting} data-testid="boost-submit">
            {submitting ? t('boostRequestSubmitting') : t('boostRequestSubmit')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
