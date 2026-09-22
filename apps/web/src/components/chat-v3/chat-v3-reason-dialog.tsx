'use client';

import { useState } from 'react';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { OperatorTextarea } from '@/components/ui/operator-control';

/**
 * story #3964(AC2)가 지은 `today-v3-reason-dialog.tsx`(얇은 Dialog-원시 조립,
 * #2061 「손으로 짠 모달 금지」 관례)를 story #3972가 「변경 요청」 사유 입력에
 * 그대로 재사용 — base=develop이라(#4365/#4367 미착지) today-v3 디렉터리 자체가
 * 없어 이 카드도 파일을 복제해 새로 얹는다(#3970과 동일 사정, 착지 뒤 rebase 1회).
 */
export function ChatV3ReasonDialog({
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
          data-testid="chat-v3-reason-textarea"
          className="resize-none"
        />
        {error ? (
          <p role="alert" aria-live="assertive" className="text-xs text-destructive">{error}</p>
        ) : null}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
            {cancelLabel}
          </Button>
          <Button onClick={() => onSubmit(reason.trim())} disabled={!canSubmit} data-testid="chat-v3-reason-submit">
            {submitLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
