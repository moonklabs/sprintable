'use client';

import type { ReactNode } from 'react';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';

interface ConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description: ReactNode;
  cancelLabel: string;
  confirmLabel: string;
  onConfirm: () => void;
  /** @default true — most confirm dialogs guard a destructive action. */
  destructive?: boolean;
  /** story f061c1a3 — 2단계 확認(예: 「채널에서 확認했습니다」 체크)이 끝나기 前까지
   * 확認 버튼 자체를 누를 수 없게 한다(disabled). @default false */
  confirmDisabled?: boolean;
}

// story #2416 — native confirm()은 브라우저 크롬(영문 고정, i18n 불가)이라 앱 카피가 못 들어간다.
// 이 컴포넌트가 그 자리를 대신한다: Dialog 원시 컴포넌트 위에 얇게(#2061 — 손으로 짠 모달 금지).
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  cancelLabel,
  confirmLabel,
  onConfirm,
  destructive = true,
  confirmDisabled = false,
}: ConfirmDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {cancelLabel}
          </Button>
          <Button variant={destructive ? 'destructive' : 'default'} onClick={onConfirm} disabled={confirmDisabled}>
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
