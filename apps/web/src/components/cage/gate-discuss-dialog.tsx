'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';

/** story #2631(FE 계약 doc bb733f26) — «보류(논의 필요)» 사유 입력. Dialog 원시 위에 얇게
 * (#2061 — 손으로 짠 모달 금지). 사유 필수(빈 값 제출 버튼에서부터 막음 — 서버도 422로
 * 이중 방어하지만 클라 우선 차단이 UX상 낫다, spec 명시). */
export function GateDiscussDialog({
  open,
  onOpenChange,
  onSubmit,
  submitting,
  error,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (reason: string) => void;
  submitting: boolean;
  error?: string | null;
}) {
  const t = useTranslations('cage');
  const [reason, setReason] = useState('');
  const canSubmit = reason.trim().length > 0 && !submitting;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (submitting) return;
        onOpenChange(next);
        if (!next) setReason('');
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('gateDiscussTitle')}</DialogTitle>
          <DialogDescription>{t('gateDiscussDescription')}</DialogDescription>
        </DialogHeader>
        <label className="sr-only" htmlFor="gate-discuss-reason">{t('gateDiscussReasonLabel')}</label>
        <textarea
          id="gate-discuss-reason"
          rows={3}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder={t('gateDiscussReasonPlaceholder')}
          className="w-full resize-none rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary"
        />
        {error ? (
          <p role="alert" aria-live="assertive" className="text-xs text-foreground">
            {t('gateTransitionError', { reason: error })}
          </p>
        ) : null}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
            {t('cancel')}
          </Button>
          <Button onClick={() => onSubmit(reason.trim())} disabled={!canSubmit}>
            {submitting ? '...' : t('gateDiscussSubmit')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
