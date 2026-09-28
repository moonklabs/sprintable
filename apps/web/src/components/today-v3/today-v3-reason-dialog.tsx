'use client';

import { useFieldDraft } from '@/hooks/use-field-draft';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { OperatorTextarea } from '@/components/ui/operator-control';

/**
 * story #3964(AC2) — 「변경 요청」·「보류」·hitl 「반려」의 사유 입력. `cage/gate-
 * discuss-dialog.tsx`와 같은 얇은 Dialog-원시 조립(#2061 「손으로 짠 모달 금지」
 * 관례 재사용)이지만, 그 컴포넌트는 문구가 '논의'(gateDiscussTitle 등, cage
 * 네임스페이스)로 고정돼 있어 반려/보류엔 문구가 안 맞는다 — v3 전용 문구
 * (todayV3 네임스페이스)를 받는 얇은 버전으로 둔다(다이얼로그 뼈대만 공유).
 *
 * story #4370 — 사유는 대상별 초안(`useFieldDraft` · `draftKey`): ✕ · 바깥 · Esc로 닫혀도 남고 보이는 «취소»와 성공에서만 지운다
 * (예전엔 거꾸로 — Dialog 자체 닫힘에서만 지우고 «취소» · 성공은 남겼다).
 */
export function TodayV3ReasonDialog({
  open, onOpenChange, title, placeholder, submitLabel, cancelLabel, reasonRequired, submitting, error, onSubmit, draftKey,
  testIdPrefix = 'today-v3',
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  placeholder: string;
  submitLabel: string;
  cancelLabel: string;
  reasonRequired: boolean;
  submitting: boolean;
  error?: string | null;
  /** 성공이면 true — 그때만 초안을 지운다. */
  onSubmit: (reason: string) => Promise<boolean>;
  /** 초안 키 — 표면(동작 종류까지) + 대상 id. */
  draftKey: { surface: string; targetId: string | null };
  /** 테스트 id 앞머리(채팅 v3 카드가 같은 창을 `chat-v3`로 씀). */
  testIdPrefix?: string;
}) {
  const [reason, setReason, clearReason] = useFieldDraft({ ...draftKey, field: 'form' });
  const canSubmit = (!reasonRequired || reason.trim().length > 0) && !submitting;

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
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <OperatorTextarea
          rows={3}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder={placeholder}
          aria-label={placeholder}
          data-testid={`${testIdPrefix}-reason-textarea`}
          className="resize-none"
        />
        {error ? (
          <p role="alert" aria-live="assertive" className="text-xs text-destructive">{error}</p>
        ) : null}
        <DialogFooter>
          <Button variant="outline" onClick={() => { clearReason(); onOpenChange(false); }} disabled={submitting}>
            {cancelLabel}
          </Button>
          <Button onClick={() => { void onSubmit(reason.trim()).then((ok) => { if (ok) clearReason(); }); }} disabled={!canSubmit} data-testid={`${testIdPrefix}-reason-submit`}>
            {submitLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
