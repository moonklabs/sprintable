'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { validateScheduledAt } from '@/components/content/validate-scheduled-at';

// story #3422 ②-d 2/N(doc §11 T8) — 상신 시 scheduled_at 입력 UI. 검증은
// validateScheduledAt(BE 실물 규칙 재현)을 그대로 재사용 — 이 다이얼로그는 그 결과를
// 화면에 옮기기만 한다(판단을 다시 하지 않는다).
export interface ScheduleAtDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (iso: string) => void;
  submitting?: boolean;
}

export function ScheduleAtDialog({ open, onOpenChange, onSubmit, submitting }: ScheduleAtDialogProps) {
  const t = useTranslations('content');
  const [value, setValue] = useState('');
  const [touched, setTouched] = useState(false);

  const validation = validateScheduledAt(value);
  const showError = touched && !validation.valid && value !== '';

  const handleConfirm = () => {
    setTouched(true);
    if (validation.valid) onSubmit(validation.iso);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="channel-post-schedule-at-dialog">
        <DialogHeader>
          <DialogTitle>{t('channelPostsScheduleAtDialogTitle')}</DialogTitle>
          <DialogDescription>{t('channelPostsScheduleAtDialogDescription')}</DialogDescription>
        </DialogHeader>
        <input
          type="datetime-local"
          value={value}
          onChange={(e) => { setValue(e.target.value); setTouched(true); }}
          className="rounded-md border border-input bg-background px-3 py-2 text-sm"
          data-testid="channel-post-schedule-at-input"
        />
        {showError ? (
          <p className="text-xs text-destructive" data-testid="channel-post-schedule-at-error">
            {validation.reason === 'past' ? t('channelPostsScheduleAtErrorPast') : t('channelPostsScheduleAtErrorInvalid')}
          </p>
        ) : null}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>{t('channelPostsScheduleAtDialogCancel')}</Button>
          <Button onClick={handleConfirm} disabled={submitting} data-testid="channel-post-schedule-at-confirm">
            {t('channelPostsScheduleAtDialogConfirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
