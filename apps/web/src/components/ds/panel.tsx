'use client';

import type { ComponentProps } from 'react';
import { Dialog as DialogPrimitive } from '@base-ui/react/dialog';
import { useTranslations } from 'next-intl';
import { cn } from '@/lib/utils';
import { DialogOverlay } from '@/components/ui/dialog';
import { Dialog, DialogClose, DialogDescription, DialogHeader, DialogTitle, DialogTrigger, type DialogName } from './dialog';
import { IconButton } from './icon-button';

export { Dialog as Panel, DialogTrigger as PanelTrigger, DialogClose as PanelClose, DialogTitle as PanelTitle, DialogDescription as PanelDescription };

/** 패널도 접근성 이름이 필수다(`PanelTitle`의 id를 `aria-labelledby`로, 없으면 `aria-label`). */
export type PanelContentProps = Omit<DialogPrimitive.Popup.Props, 'className' | 'aria-label' | 'aria-labelledby'> & DialogName & { className?: string };

/**
 * UI-3(a9d56577) Panel · Sheet — doc §4 #14. 넓은 화면(lg 이상) = 오른쪽에 붙는 폭 400 패널 · 좁은 화면 = 아래에서 오르는 높이 92% 시트.
 * 초점 가둠 · Esc · 바깥 눌러 닫기는 Dialog와 같은 갈래(한 Esc = 한 층). 닫기(X)는 항상 있다(머리 줄 오른쪽) — 폰에서 잡을 길이 하나 더 있다.
 * 레이아웃 분기는 CSS(`lg:`)만 쓴다 — JS 폭 판정을 새로 두지 않는다.
 */
export function PanelContent({ className, children, ...props }: PanelContentProps) {
  const t = useTranslations('common');
  return (
    <DialogPrimitive.Portal>
      <DialogOverlay className="bg-ds-scrim/55" />
      <DialogPrimitive.Popup
        data-modal-popup=""
        data-slot="ds-panel"
        data-close-button=""
        className={cn(
          'group/dialog fixed z-50 flex flex-col bg-ds-surface-raised text-ds-body text-ds-ink shadow-ds-overlay outline-none',
          'inset-x-0 bottom-0 max-h-[92dvh] rounded-t-ds-panel border-t border-ds-line-control',
          'lg:inset-y-0 lg:right-0 lg:left-auto lg:max-h-none lg:w-100 lg:rounded-none lg:border-t-0 lg:border-l',
          'duration-(--ds-duration-fast) motion-reduce:duration-(--ds-duration-instant) data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0',
          className,
        )}
        {...props}
      >
        {children}
        <DialogPrimitive.Close render={<IconButton icon="close" label={t('close')} className="absolute top-2 right-2" />} />
      </DialogPrimitive.Popup>
    </DialogPrimitive.Portal>
  );
}

/** 머리 줄 — 제목(+ 보조 글). 닫기(X) 자리를 오른쪽에 비운다. */
export function PanelHeader({ className, ...props }: ComponentProps<'div'>) {
  return <DialogHeader data-panel-header="" className={cn('border-b border-ds-line px-4 py-3', className)} {...props} />;
}

/** 본문 — 길면 안에서 스크롤. */
export function PanelBody({ className, ...props }: ComponentProps<'div'>) {
  return <div data-slot="ds-panel-body" className={cn('min-h-0 flex-1 overflow-y-auto p-4', className)} {...props} />;
}
