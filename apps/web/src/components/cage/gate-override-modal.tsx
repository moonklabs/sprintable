'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Gavel, Crown } from 'lucide-react';
import { Button } from '@/components/ui/button';

/**
 * E-DG S33 — owner 결재 강제(override) 확인 모달. 가장 무거운 confirm:
 * 👑 owner-only(BE is_org_owner 강제)·SoD 우회·되돌릴 수 없음. 사유 필수 + "OVERRIDE" typed-confirm
 * 이중 장벽(둘 다 채워야 활성). POST /api/gates/{id}/override {decision, reason} → onResolved. 신규 토큰 0.
 */
const CONFIRM_WORD = 'OVERRIDE';

export function GateOverrideModal({
  gateId,
  onClose,
  onResolved,
}: {
  gateId: string;
  onClose: () => void;
  onResolved: () => void;
}) {
  const t = useTranslations('cage');
  const [decision, setDecision] = useState<'approved' | 'rejected' | ''>('');
  const [reason, setReason] = useState('');
  const [typed, setTyped] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const canSubmit = !!decision && reason.trim().length > 0 && typed === CONFIRM_WORD && !submitting;

  const submit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    try {
      const res = await fetch(`/api/gates/${gateId}/override`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ decision, reason: reason.trim() }),
      });
      if (res.ok) { onResolved(); onClose(); }
    } finally {
      setSubmitting(false);
    }
  };

  const inputCls = 'w-full rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-destructive/40';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <button type="button" className="absolute inset-0 bg-black/50 backdrop-blur-[2px]" onClick={onClose} aria-label={t('cancel')} />
      <div className="relative z-10 w-full max-w-sm rounded-2xl border border-destructive/40 bg-background p-5 shadow-xl">
        <div className="mb-2 flex items-center gap-2">
          <Gavel className="size-4 shrink-0 text-destructive" />
          <h3 className="text-sm font-semibold text-foreground">{t('overrideTitle')}</h3>
          <span className="ml-auto inline-flex items-center gap-1 text-[11px] text-warning"><Crown className="size-3" />{t('overrideOwnerOnly')}</span>
        </div>
        <p className="mb-3 rounded-lg border border-destructive/30 bg-destructive/5 p-2.5 text-xs text-foreground">{t('overrideImpact')}</p>

        <p className="mb-1 text-xs text-muted-foreground">{t('overrideDecisionLabel')}</p>
        <div className="mb-3 flex items-center gap-4 text-xs text-foreground">
          <label className="flex items-center gap-1.5">
            <input type="radio" name="overrideDecision" checked={decision === 'approved'} onChange={() => setDecision('approved')} />
            {t('overrideApprove')}
          </label>
          <label className="flex items-center gap-1.5">
            <input type="radio" name="overrideDecision" checked={decision === 'rejected'} onChange={() => setDecision('rejected')} />
            {t('overrideReject')}
          </label>
        </div>

        <textarea
          rows={2}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder={t('overrideReasonPlaceholder')}
          className={`${inputCls} mb-2 resize-none`}
        />
        <label className="mb-1 block text-xs text-muted-foreground">{t('overrideTypedLabel', { word: CONFIRM_WORD })}</label>
        <input
          type="text"
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          placeholder={CONFIRM_WORD}
          className={inputCls}
        />

        <div className="mt-3 flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onClose}>{t('cancel')}</Button>
          <Button
            variant="ghost"
            size="sm"
            className="gap-1 text-destructive hover:bg-destructive/10 hover:text-destructive"
            disabled={!canSubmit}
            onClick={() => void submit()}
          >
            <Gavel className="size-3.5" />
            {submitting ? '...' : t('overrideConfirm')}
          </Button>
        </div>
      </div>
    </div>
  );
}
