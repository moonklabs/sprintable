'use client';

import { useTranslations } from 'next-intl';
import { Dialog as DialogPrimitive } from '@base-ui/react/dialog';
import { cn } from '@/lib/utils';
import { ArtifactStage } from './artifact-stage';
import type { ArtifactFormat } from '@/services/canvas';

interface ArtifactExpandDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  format: ArtifactFormat;
  content: string;
}

/**
 * "크게 보기" 모달(story d425dccc 원조·story 3d888ba2에서 스토리 상세 뷰어와 갤러리가 공유하도록
 * 추출) — 큰 표면(≈90vw×85vh)에서 ArtifactStage를 `fill` 모드로 재렌더(html=실제 크기+직접
 * 드래그 pan, image/tree=해당 포맷 그대로). 신규 뷰어 0 — 기존 컴포넌트 재사용.
 */
export function ArtifactExpandDialog({ open, onOpenChange, title, format, content }: ArtifactExpandDialogProps) {
  const t = useTranslations('canvas');

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Backdrop className="fixed inset-0 z-50 bg-black/40 data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0" />
        <DialogPrimitive.Popup
          className={cn(
            'fixed top-1/2 left-1/2 z-50 flex h-[85vh] w-[90vw] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden',
            'rounded-xl bg-card shadow-lg ring-1 ring-foreground/10 outline-none',
            'data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95',
            'data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95',
          )}
        >
          <div className="flex items-center gap-2 border-b border-border px-4 py-2.5">
            <DialogPrimitive.Title className="truncate text-sm font-semibold text-foreground">
              {title}
            </DialogPrimitive.Title>
            <DialogPrimitive.Close
              className="ml-auto rounded-md border border-border px-2 py-1 text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              {t('closeAction')}
            </DialogPrimitive.Close>
          </div>
          <div className="min-h-0 flex-1 overflow-hidden p-4">
            <ArtifactStage format={format} content={content} title={title} fill />
          </div>
        </DialogPrimitive.Popup>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
