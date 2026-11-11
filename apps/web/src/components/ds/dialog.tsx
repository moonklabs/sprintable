'use client';

import { useId, type ComponentProps, type ReactNode } from 'react';
import { Dialog as DialogPrimitive } from '@base-ui/react/dialog';
import { useTranslations } from 'next-intl';
import { cn } from '@/lib/utils';
import { guardEscClose } from '@/lib/inner-layer-esc';
// 바깥 어둠 막의 «틀»은 바탕 부품(ui/dialog)의 것을 쓴다 — 새 전체 화면 덮개를 손으로 짓지 않는다(verify:design-base). 색만 새 토큰 `ds-scrim` 55%로 덮어쓴다(cn이 옛 bg-scrim-2를 치운다).
import { DialogOverlay } from '@/components/ui/dialog';
import { Button } from './button';
import { IconButton } from './icon-button';

// [SID:4367] 한 Esc = 한 층 · [SID:4369] 조합 중 Esc · 글 있는 여러 줄 칸의 첫 Esc는 닫지 않는다 — 현행 `ui/dialog`와 같은 갈래를 그대로 거친다(inner-layer-esc.ts).
export function Dialog({ onOpenChange, ...props }: DialogPrimitive.Root.Props) {
  return (
    <DialogPrimitive.Root
      data-slot="ds-dialog"
      onOpenChange={(open, details) => {
        if (guardEscClose(open, details)) return;
        onOpenChange?.(open, details);
      }}
      {...props}
    />
  );
}

export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogClose = DialogPrimitive.Close;

/** 창의 접근성 이름이 필수다 — 보통 `DialogTitle`의 id를 `aria-labelledby`로(제목이 없으면 `aria-label`). 이름 없는 role=dialog는 스크린리더가 «무슨 창인지» 모른다. */
export type DialogName = { 'aria-labelledby': string; 'aria-label'?: never } | { 'aria-label': string; 'aria-labelledby'?: never };

export type DialogContentProps = Omit<DialogPrimitive.Popup.Props, 'className' | 'aria-label' | 'aria-labelledby'> & DialogName & {
  className?: string;
  /** 오른쪽 위 닫기(X). 기본 켬 — 닫을 길이 «아래 단추»뿐인 확인 창은 끌 수 있다. */
  showCloseButton?: boolean;
};

/**
 * UI-3(a9d56577) Dialog — doc v0.3 #20. 폭 420 · 모서리 8 · 면 `surface-raised` · 경계 `line-control`. 초점 가둠 · Esc · 바깥 눌러 닫기는 Base UI 몫이다.
 * 용도: 확인(`ConfirmDialog`) · 사유 입력(본문에 Textarea) · 결과 판정(본문에 아이콘 + 글) — 본문은 호출부가 채운다.
 */
export function DialogContent({ className, children, showCloseButton = true, ...props }: DialogContentProps) {
  const t = useTranslations('common');
  return (
    <DialogPrimitive.Portal>
      <DialogOverlay className="bg-ds-scrim/55" />
      <DialogPrimitive.Popup
        data-modal-popup=""
        data-slot="ds-dialog-content"
        data-close-button={showCloseButton ? '' : undefined}
        className={cn(
          'group/dialog fixed top-1/2 left-1/2 z-50 grid max-h-[calc(100dvh-2rem)] w-full max-w-[calc(100%-2rem)] -translate-x-1/2 -translate-y-1/2 grid-cols-[minmax(0,1fr)] gap-3 overflow-y-auto rounded-ds-panel border border-ds-line-control bg-ds-surface-raised p-4 text-ds-body text-ds-ink shadow-ds-overlay outline-none sm:max-w-105',
          'duration-(--ds-duration-fast) motion-reduce:duration-(--ds-duration-instant) data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95',
          className,
        )}
        {...props}
      >
        {children}
        {showCloseButton ? (
          <DialogPrimitive.Close render={<IconButton icon="close" label={t('close')} className="absolute top-2 right-2" />} />
        ) : null}
      </DialogPrimitive.Popup>
    </DialogPrimitive.Portal>
  );
}

export function DialogHeader({ className, ...props }: ComponentProps<'div'>) {
  return <div data-slot="ds-dialog-header" className={cn('flex flex-col gap-1 group-data-[close-button]/dialog:pr-9 group-data-[close-button]/dialog:touch:pr-14', className)} {...props} />;
}

export function DialogTitle({ className, ...props }: DialogPrimitive.Title.Props) {
  // 머리 줄(DialogHeader) 밖에서 곧장 쓰면 닫기(X) 밑으로 들어가지 않게 제목이 오른쪽을 비운다(머리 줄 안이면 줄이 이미 비웠으므로 이중으로 안 비운다).
  return <DialogPrimitive.Title data-slot="ds-dialog-title" className={cn('text-ds-card-title font-semibold text-ds-ink break-keep [overflow-wrap:anywhere] group-data-[close-button]/dialog:not-in-data-[slot=ds-dialog-header]:pr-9 group-data-[close-button]/dialog:not-in-data-[slot=ds-dialog-header]:touch:pr-14', className as string)} {...props} />;
}

export function DialogDescription({ className, ...props }: DialogPrimitive.Description.Props) {
  return <DialogPrimitive.Description data-slot="ds-dialog-description" className={cn('text-ds-body text-ds-ink-2 break-keep [overflow-wrap:anywhere]', className as string)} {...props} />;
}

/** 아래 단추 줄 — 보조(왼쪽) + 주(오른쪽), 좁으면 위아래로 쌓는다. */
export function DialogFooter({ className, ...props }: ComponentProps<'div'>) {
  return <div data-slot="ds-dialog-footer" className={cn('flex flex-col-reverse gap-2 sm:flex-row sm:justify-end', className)} {...props} />;
}

export interface ConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  confirmLabel: string;
  cancelLabel: string;
  /** `danger`면 확인 단추가 위험 모양이고, 처음 초점이 «취소»에 놓인다(Enter 한 번으로 지우지 않게). */
  tone?: 'default' | 'danger';
  onConfirm: () => void;
  /** 확인이 일하는 중이면 확인 단추가 불러오는 중이 된다(눌러도 한 번만). */
  loading?: boolean;
}

/**
 * 확인 한 단계 — 위험 확인 = 위험 Button. 닫기(X)는 없고 길은 «취소» · Esc · 바깥뿐이다.
 * 처음 초점은 «취소»다(Enter 한 번으로 지우지 않게) — 단추 순서가 취소 → 확인이라 Base UI의 첫 초점이 취소에 놓인다(순서를 바꾸면 시험이 빨개진다).
 */
export function ConfirmDialog({ open, onOpenChange, title, description, confirmLabel, cancelLabel, tone = 'default', onConfirm, loading = false }: ConfirmDialogProps) {
  const titleId = useId();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent showCloseButton={false} aria-labelledby={titleId}>
        <DialogHeader>
          <DialogTitle id={titleId}>{title}</DialogTitle>
          {description ? <DialogDescription>{description}</DialogDescription> : null}
        </DialogHeader>
        <DialogFooter>
          <DialogClose render={<Button variant="secondary" />}>{cancelLabel}</DialogClose>
          <Button variant={tone === 'danger' ? 'danger' : 'primary'} loading={loading} onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
