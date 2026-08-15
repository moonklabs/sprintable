'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import type { Hypothesis } from '@sprintable/core-storage';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { useIsMobile } from '@/hooks/use-mobile';
import { GuidedHypothesisForm } from './guided-hypothesis-form';

/**
 * story #2543(#2542 FE 이관, 유나 SSOT ae75a8ff) — 빈 지도 초대. 가설 0건일 때 지구층
 * 그리드 자리에 이 초대가 대신 선다("죽은 0"이 아니라 첫 질문을 심자는 문턱 낮은 CTA).
 * 모바일=풀스크린 시트(엄지존 CTA) · 데스크톱=모달(useIsMobile 게이트, SSOT=lg — flow의
 * 다른 useIsMobile 사용처(flow-node-story-panel.tsx)와 같은 브레이크포인트).
 */
export function GuidedHypothesisEntry({
  projectId,
  onCreated,
}: {
  projectId: string;
  onCreated: (hypothesis: Hypothesis) => void;
}) {
  const t = useTranslations('flow');
  const isMobile = useIsMobile();
  const [open, setOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(false);

  const handleSubmit = async (value: { statement: string; metric: string; target: number; direction: 'up' | 'down' }) => {
    setSubmitting(true);
    setError(false);
    try {
      const res = await fetch('/api/hypotheses/guided', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project_id: projectId, ...value }),
      });
      if (!res.ok) throw new Error('failed');
      const json = await res.json() as { data: Hypothesis };
      setOpen(false);
      onCreated(json.data);
    } catch {
      setError(true);
    } finally {
      setSubmitting(false);
    }
  };

  const form = (
    <>
      <GuidedHypothesisForm submitting={submitting} onSubmit={handleSubmit} onCancel={() => setOpen(false)} />
      {error ? <p className="pt-1 text-xs text-destructive">{t('guidedError')}</p> : null}
    </>
  );

  return (
    <div className="flex flex-col items-center gap-4 rounded-2xl border border-dashed border-border bg-muted/20 px-6 py-10 text-center">
      <span aria-hidden="true" className="text-3xl opacity-40">◐</span>
      <div className="space-y-1">
        <h3 className="text-sm font-semibold text-foreground">{t('earthEmptyInviteTitle')}</h3>
        <p className="max-w-xs text-xs text-muted-foreground">{t('earthEmptyInviteBody')}</p>
      </div>
      <Button className="w-full max-w-xs sm:w-auto" onClick={() => setOpen(true)}>
        {t('earthEmptyInviteCta')} →
      </Button>

      {isMobile ? (
        <Sheet open={open} onOpenChange={setOpen}>
          <SheetContent side="bottom" className="flex h-[92vh] max-h-[92vh] flex-col rounded-t-2xl p-0">
            <SheetHeader className="border-b border-border">
              <SheetTitle>{t('guidedFormTitle')}</SheetTitle>
            </SheetHeader>
            <div className="flex min-h-0 flex-1 flex-col p-4">{form}</div>
          </SheetContent>
        </Sheet>
      ) : (
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogContent className="flex max-h-[85vh] flex-col sm:max-w-md">
            <DialogHeader>
              <DialogTitle>{t('guidedFormTitle')}</DialogTitle>
            </DialogHeader>
            {form}
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}
