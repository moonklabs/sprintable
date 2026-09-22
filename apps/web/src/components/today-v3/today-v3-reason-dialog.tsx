'use client';

import { useState } from 'react';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { OperatorTextarea } from '@/components/ui/operator-control';

/**
 * story #3964(AC2) — 「변경 요청」·「보류」·hitl 「반려」의 사유 입력. `cage/gate-
 * discuss-dialog.tsx`와 같은 얇은 Dialog-원시 조립(#2061 「손으로 짠 모달 금지」
 * 관례 재사용)이지만, 그 컴포넌트는 문구가 '논의'(gateDiscussTitle 등, cage
 * 네임스페이스)로 고정돼 있어 반려/보류엔 문구가 안 맞는다 — v3 전용 문구
 * (todayV3 네임스페이스)를 받는 얇은 버전으로 둔다(다이얼로그 뼈대만 공유).
 */
export function TodayV3ReasonDialog({
  open, onOpenChange, title, placeholder, submitLabel, cancelLabel, reasonRequired, submitting, error, onSubmit,
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
  onSubmit: (reason: string) => void;
}) {
  const [reason, setReason] = useState('');
  const canSubmit = (!reasonRequired || reason.trim().length > 0) && !submitting;

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
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <OperatorTextarea
          rows={3}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder={placeholder}
          aria-label={placeholder}
          data-testid="today-v3-reason-textarea"
          className="resize-none"
        />
        {error ? (
          <p role="alert" aria-live="assertive" className="text-xs text-destructive">{error}</p>
        ) : null}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
            {cancelLabel}
          </Button>
          <Button onClick={() => onSubmit(reason.trim())} disabled={!canSubmit} data-testid="today-v3-reason-submit">
            {submitLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
