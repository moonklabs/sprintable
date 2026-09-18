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
  // 페드루 PO 지적(2026-09-04 10:49Z) — 클라 검증 통과 뒤에도 상신 사이 시각이 흘러
  // 서버가 422로 거부하는 실제 경로가 있다(parseScheduledAtServerError 참고). 다이얼로그는
  // 안 닫힌다(다시 선택 가능) — open을 부모가 그대로 유지하면 자연히 재선택 경로가 된다.
  serverError?: 'past_or_invalid' | null;
}

export function ScheduleAtDialog({ open, onOpenChange, onSubmit, submitting, serverError }: ScheduleAtDialogProps) {
  const t = useTranslations('content');
  const [value, setValue] = useState('');
  const [touched, setTouched] = useState(false);

  const validation = validateScheduledAt(value);
  // 페드루 PO 지적(N1, 2026-09-04 12:3x) — value==='' 제외 조건 탓에 빈 값인 채로
  // 확인을 눌러도(touched=true·validation.valid=false) 아무 피드백이 없었다(버튼도
  // 안 막고 오류도 안 뜨고 onSubmit도 안 불림 — 사용자가 클릭이 씹혔다고 느낀다).
  // validateScheduledAt은 빈 값도 reason:'invalid'로 판정하므로 그 값을 그대로 쓴다.
  const showError = touched && !validation.valid;

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
        {serverError ? (
          <p className="text-xs text-destructive" data-testid="channel-post-schedule-at-server-error">
            {t('channelPostsScheduleAtServerErrorPastOrInvalid')}
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
