'use client';

/**
 * story #4335 — 결제 시도 한 건의 화면 상태. 요청을 보낸 직후(처리 중) · 끊김 · 시간 초과 · 새로고침 · 재진입 뒤(확인 중)
 * 모두 **조회**(`fetchAttempt`)로만 결과를 확정한다 — 결제 요청을 다시 보내지 않는다.
 *
 * 문장(유나 확정 표 · 스토리 본문): 처리 중 `paymentAttemptProcessing` · 확인 중 `paymentAttemptChecking`(+ 오래 걸리면
 * `paymentAttemptCheckingLong`) · 완료 `checkoutSuccessBanner`/`changeTierSuccessBanner` · 거절 `checkoutDeclinedBanner`
 * (+ `checkoutDeclinedReason` · `checkoutDeclinedReassurance`) · 실패 `paymentAttemptFailed`(+ 안심 줄 · 다시 시도) ·
 * 카드 인증부터 다시 `paymentAttemptReauthRequired`(+ `checkoutDialogConfirm`). 색: 처리/확인 = 정보 · 완료 = 성공 ·
 * 거절/실패/인증 다시 = 경고(빨강 아님).
 *
 * «청구된 금액은 없어요»(`checkoutDeclinedReassurance`)는 서버가 청구 0을 증명한 결과(declined · failed)이거나 시도가 서버에
 * 아예 없을 때(=만들어지지 않음)만 뜬다 — 확인 중엔 뜨지 않는다.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Loader2 } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  fetchAttempt,
  forgetAttempt,
  rememberAttempt,
  type AttemptResult,
  type PaymentAttempt,
  type PaymentAttemptKind,
} from './payment-attempt';

export const ATTEMPT_POLL_MS = 2000;
export const ATTEMPT_LONG_MS = 20000;

type Phase = 'processing' | 'checking' | 'done';

export interface PaymentAttemptState {
  id: string;
  kind: PaymentAttemptKind;
  phase: Phase;
  attempt: PaymentAttempt | null;
  /** 서버에 이 시도가 없다(요청이 닿지 않음) — 청구 0. */
  missing: boolean;
  /** 결제 요청 자체가 거절됨(400 · 409 · 500 등) — 시도가 만들어지지 않았다. */
  rejectedStatus: number | null;
  long: boolean;
}

export function usePaymentAttempt({ onSettled }: { onSettled?: (attempt: PaymentAttempt) => void } = {}) {
  const [state, setState] = useState<PaymentAttemptState | null>(null);
  const onSettledRef = useRef(onSettled);
  useEffect(() => {
    onSettledRef.current = onSettled;
  }, [onSettled]);

  const settle = useCallback((id: string, result: AttemptResult) => {
    if (result.kind === 'ok' && result.attempt.status !== 'processing') {
      forgetAttempt();
      setState((s) => (s && s.id === id ? { ...s, phase: 'done', attempt: result.attempt } : s));
      onSettledRef.current?.(result.attempt);
      return true;
    }
    if (result.kind === 'notFound') {
      forgetAttempt();
      setState((s) => (s && s.id === id ? { ...s, phase: 'done', missing: true } : s));
      return true;
    }
    if (result.kind === 'ok') {
      setState((s) => (s && s.id === id ? { ...s, attempt: result.attempt } : s));
    }
    return false;
  }, []);

  /** 결제 요청을 보낸 직후. 응답이 끊기거나 늦으면 «확인 중»으로 넘어가 조회만 한다. */
  const start = useCallback((id: string, kind: PaymentAttemptKind, request: Promise<AttemptResult>) => {
    rememberAttempt({ id, kind });
    setState({ id, kind, phase: 'processing', attempt: null, missing: false, rejectedStatus: null, long: false });
    void request.then((result) => {
      if (result.kind === 'rejected') {
        forgetAttempt();
        setState((s) => (s && s.id === id ? { ...s, phase: 'done', rejectedStatus: result.status } : s));
        return;
      }
      if (result.kind === 'unreached') {
        setState((s) => (s && s.id === id && s.phase === 'processing' ? { ...s, phase: 'checking' } : s));
        return;
      }
      settle(id, result);
    });
  }, [settle]);

  /** 새로고침 · 재진입 — 요청은 이미 갔다. 조회만. */
  const resume = useCallback((id: string, kind: PaymentAttemptKind) => {
    setState({ id, kind, phase: 'checking', attempt: null, missing: false, rejectedStatus: null, long: false });
  }, []);

  const dismiss = useCallback(() => setState(null), []);

  const id = state?.id ?? null;
  const active = state != null && state.phase !== 'done';
  useEffect(() => {
    if (id == null || !active) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      const result = await fetchAttempt(id);
      if (cancelled) return;
      if (!settle(id, result)) timer = setTimeout(tick, ATTEMPT_POLL_MS);
    };
    timer = setTimeout(tick, ATTEMPT_POLL_MS);
    const longTimer = setTimeout(() => {
      setState((s) => (s && s.id === id && s.phase !== 'done' ? { ...s, long: true } : s));
    }, ATTEMPT_LONG_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      clearTimeout(longTimer);
    };
  }, [id, active, settle]);

  return { state, start, resume, dismiss };
}

export function PaymentAttemptBanner({
  state,
  onRetry,
  onReauth,
}: {
  state: PaymentAttemptState;
  onRetry: (attempt: { kind: PaymentAttemptKind; tier: string; billingCycle: string | null }) => void;
  onReauth: (attempt: { tier: string; billingCycle: string | null }) => void;
}) {
  const t = useTranslations('pricingPlans');
  const tc = useTranslations('common');
  const { attempt } = state;

  if (state.phase !== 'done') {
    return (
      <Alert variant="info" data-payment-attempt-state={state.phase}>
        <AlertDescription className="flex items-start gap-2">
          <Loader2 className="mt-0.5 h-4 w-4 shrink-0 animate-spin" />
          <span className="space-y-1">
            <span className="block">{t(state.phase === 'processing' ? 'paymentAttemptProcessing' : 'paymentAttemptChecking')}</span>
            {state.long && <span className="block">{t('paymentAttemptCheckingLong')}</span>}
          </span>
        </AlertDescription>
      </Alert>
    );
  }

  if (state.rejectedStatus != null) {
    // 시도가 만들어지지 않았다 = 청구 0이 참 — 거절 · 실패와 같은 규칙(돈 안 빠짐 = 경고, 빨강 아님 · 유나).
    return (
      <Alert variant="warning" data-payment-attempt-state="rejected">
        <AlertDescription className="space-y-1">
          <span className="block">{t('checkoutErrorBanner')}</span>
          <span className="block">{t('checkoutDeclinedReassurance')}</span>
        </AlertDescription>
      </Alert>
    );
  }

  const tier = attempt?.tier ?? '';
  const billingCycle = attempt?.billing_cycle ?? null;
  const reauth = state.missing ? state.kind === 'checkout' : attempt?.status === 'failed' && attempt.reauth_required;

  if (reauth) {
    return (
      <Alert variant="warning" data-payment-attempt-state="reauth">
        <AlertDescription className="space-y-2">
          <span className="block">{t('paymentAttemptReauthRequired')}</span>
          {attempt && (
            <Button size="sm" variant="outline" onClick={() => onReauth({ tier, billingCycle })}>
              {t('checkoutDialogConfirm')}
            </Button>
          )}
        </AlertDescription>
      </Alert>
    );
  }

  if (state.missing || attempt?.status === 'failed') {
    return (
      <Alert variant="warning" data-payment-attempt-state="failed">
        <AlertDescription className="space-y-2">
          <span className="block">{t('paymentAttemptFailed')}</span>
          <span className="block">{t('checkoutDeclinedReassurance')}</span>
          {attempt && (
            <Button size="sm" variant="outline" onClick={() => onRetry({ kind: state.kind, tier, billingCycle })}>
              {tc('retry')}
            </Button>
          )}
        </AlertDescription>
      </Alert>
    );
  }

  if (attempt?.status === 'declined') {
    return (
      <Alert variant="warning" data-payment-attempt-state="declined">
        <AlertDescription className="space-y-1">
          <span className="block">{t('checkoutDeclinedBanner')}</span>
          {attempt.declined_reason && <span className="block">{t('checkoutDeclinedReason', { reason: attempt.declined_reason })}</span>}
          <span className="block">{t('checkoutDeclinedReassurance')}</span>
        </AlertDescription>
      </Alert>
    );
  }

  if (attempt?.status === 'succeeded') {
    const tierName = t(`tierName_${tier}`);
    return (
      <Alert variant="success" data-payment-attempt-state="succeeded">
        <AlertDescription>
          {state.kind === 'checkout' ? t('checkoutSuccessBanner', { tier: tierName }) : t('changeTierSuccessBanner', { tier: tierName })}
        </AlertDescription>
      </Alert>
    );
  }
  return null;
}
