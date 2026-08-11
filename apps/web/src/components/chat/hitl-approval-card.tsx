'use client';

import { useEffect, useMemo, useState } from 'react';
import { Check, Lock, X } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { formatHitlReply, type HitlRequest } from '@/lib/hitl-classifier';

export interface HitlAnswer {
  decision: 'allow' | 'deny';
  reason?: string;
}

interface HitlApprovalCardProps {
  request: HitlRequest;
  createdAt: string;
  /** story #2572 AC3: 이 요청 뒤에 이미 human allow/deny 답이 관측됐으면(다른 기기 포함) 버튼을 잠근다. */
  answer: HitlAnswer | null;
  onRespond: (content: string) => Promise<void>;
}

export function HitlApprovalCard({ request, createdAt, answer, onRespond }: HitlApprovalCardProps) {
  const t = useTranslations('chats');
  const deadline = useMemo(
    () => new Date(createdAt).getTime() + request.timeoutSec * 1000,
    [createdAt, request.timeoutSec],
  );
  const [submitting, setSubmitting] = useState(false);
  const [showDenyInput, setShowDenyInput] = useState(false);
  const [reason, setReason] = useState('');
  const [sendError, setSendError] = useState(false);

  const isSettled = answer !== null;

  // AC3: 만료 표시 — 아직 미응답인 동안에만 1초 tick으로 재평가(응답 후엔 재렌더 불필요).
  const [, forceTick] = useState(0);
  useEffect(() => {
    if (isSettled) return;
    const id = setInterval(() => forceTick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [isSettled]);

  const isExpired = !isSettled && Date.now() >= deadline;
  // AC3: 중복 클릭 방지 — 이미 응답됨(타 기기 포함) · 만료됨 · 전송 중 모두 잠금.
  const locked = isSettled || isExpired || submitting;

  const respond = async (content: string) => {
    setSendError(false);
    setSubmitting(true);
    try {
      await onRespond(content);
      setShowDenyInput(false);
    } catch {
      setSendError(true);
    } finally {
      setSubmitting(false);
    }
  };

  const statusLabel = isSettled
    ? answer.decision === 'allow' ? t('hitlApproved') : t('hitlDenied')
    : isExpired ? t('hitlExpired') : null;

  return (
    <div className="min-w-0 max-w-full rounded-xl rounded-tl-sm border border-warning-border bg-warning-bg px-3.5 py-3">
      <div className="mb-1.5 flex items-center gap-1.5 text-[11px] font-medium text-warning">
        <Lock className="h-3 w-3" aria-hidden />
        {t('hitlRequestLabel')}
      </div>

      <code className="mb-1.5 inline-block max-w-full truncate rounded bg-black/5 px-1.5 py-0.5 font-mono text-xs text-foreground dark:bg-white/10">
        {request.toolName}
      </code>

      <pre className="mb-2.5 max-h-32 overflow-auto scrollbar-visible whitespace-pre-wrap break-all rounded-lg bg-black/5 p-2 font-mono text-[11px] leading-relaxed text-muted-foreground dark:bg-white/5">
        {request.inputSummary}
      </pre>

      {statusLabel ? (
        <div className="flex flex-wrap items-center gap-1.5 text-xs font-medium text-foreground">
          {isSettled && (answer.decision === 'allow' ? <Check className="h-3.5 w-3.5 text-primary" /> : <X className="h-3.5 w-3.5 text-destructive" />)}
          {statusLabel}
          {isSettled && answer.reason && <span className="font-normal text-muted-foreground">— {answer.reason}</span>}
        </div>
      ) : showDenyInput ? (
        <div className="flex flex-col gap-1.5 sm:flex-row">
          <Input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder={t('hitlDenyReasonPlaceholder')}
            disabled={locked}
            className="h-8 flex-1 text-xs"
            autoFocus
          />
          <div className="flex gap-1.5">
            <Button
              type="button"
              size="sm"
              variant="destructive"
              onClick={() => void respond(formatHitlReply('deny', reason))}
              disabled={locked}
              className="flex-1 sm:flex-none"
            >
              {t('hitlDenySubmit')}
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => setShowDenyInput(false)} disabled={submitting}>
              {t('hitlCancel')}
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex gap-1.5">
          <Button
            type="button"
            size="sm"
            onClick={() => void respond(formatHitlReply('allow'))}
            disabled={locked}
            className="flex-1"
          >
            <Check className="h-3.5 w-3.5" aria-hidden />
            {t('hitlAllow')}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="destructive"
            onClick={() => setShowDenyInput(true)}
            disabled={locked}
            className="flex-1"
          >
            <X className="h-3.5 w-3.5" aria-hidden />
            {t('hitlDeny')}
          </Button>
        </div>
      )}

      {sendError && (
        <p role="alert" aria-live="assertive" className="mt-1.5 text-[11px] text-destructive">
          {t('hitlSendFailed')}
        </p>
      )}
    </div>
  );
}
