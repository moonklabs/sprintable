'use client';

import { useFieldDraft } from '@/hooks/use-field-draft';
import { useTranslations } from 'next-intl';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';

/** story #2631(FE 계약 doc bb733f26) — «보류(논의 필요)» 사유 입력. Dialog 원시 위에 얇게
 * (#2061 — 손으로 짠 모달 금지). 사유 필수(빈 값 제출 버튼에서부터 막음 — 서버도 422로
 * 이중 방어하지만 클라 우선 차단이 UX상 낫다, spec 명시).
 *
 * story #4370 — 사유는 게이트별 초안(`useFieldDraft`): ✕ · 바깥 누름 · Esc로 닫혀도 남고, 보이는 «취소»와 **보내기 성공**에서만 지운다
 * (예전엔 거꾸로 — 닫힘에선 지우고 «취소» · 성공은 남겨 다시 열면 옛 글). 한 인스턴스를 여러 게이트가 공유하는 자리(받은함)에서도
 * 게이트마다 제 초안이라 다른 게이트 창에 새지 않는다. */
export function GateDiscussDialog({
  open,
  onOpenChange,
  onSubmit,
  submitting,
  error,
  targetId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 성공이면 true — 그때만 초안을 지운다. */
  onSubmit: (reason: string) => Promise<boolean>;
  /** 사유가 속한 게이트 id(초안 키). */
  targetId: string | null;
  submitting: boolean;
  error?: string | null;
}) {
  const t = useTranslations('cage');
  const [reason, setReason, clearReason] = useFieldDraft({ surface: 'gate-discuss', targetId, field: 'form' });
  const canSubmit = reason.trim().length > 0 && !submitting;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (submitting) return;
        onOpenChange(next);  // 닫혀도 초안은 남긴다(✕ · 바깥 · Esc)
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
          <Button variant="outline" onClick={() => { clearReason(); onOpenChange(false); }} disabled={submitting}>
            {t('cancel')}
          </Button>
          <Button onClick={() => { void onSubmit(reason.trim()).then((ok) => { if (ok) clearReason(); }); }} disabled={!canSubmit}>
            {submitting ? '...' : t('gateDiscussSubmit')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
