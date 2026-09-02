'use client';

import { useState } from 'react';
import { AlertTriangle, Link2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Dialog, DialogClose, DialogContent } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { ToastContainer, useToast } from '@/components/ui/toast';
import { StorageSourceUsageList } from './storage-source-usage-list';
import type { Asset } from '@/lib/storage/types';

interface StorageDeleteDialogProps {
  asset: Asset | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDeleted: (id: string) => void;
}

export function StorageDeleteDialog({ asset, open, onOpenChange, onDeleted }: StorageDeleteDialogProps) {
  const t = useTranslations('storage');
  const { toasts, addToast, dismissToast } = useToast();
  const [deleting, setDeleting] = useState(false);

  const usageCount = asset?.source_links.length ?? 0;

  async function handleConfirm() {
    if (!asset) return;
    setDeleting(true);
    try {
      // story #3241: 서버 DELETE 핸들러 신설됨(S7 착지) — 비-2xx/예외는 삭제 실패 전용 카피로
      // toast(구 errorTitle/errorDesc는 «자산을 불러오지 못했습니다» 로드-실패 문구라 오용이었음).
      const res = await fetch(`/api/assets/${asset.id}`, { method: 'DELETE' });
      if (!res.ok) {
        addToast({ title: t('deleteErrorTitle'), body: t('deleteErrorDesc'), type: 'error' });
        return;
      }
      onDeleted(asset.id);
      onOpenChange(false);
    } catch {
      addToast({ title: t('deleteErrorTitle'), body: t('deleteErrorDesc'), type: 'error' });
    } finally {
      setDeleting(false);
    }
  }

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent
          showCloseButton={false}
          className="flex w-[440px] max-w-[calc(100%-2rem)] flex-col gap-0 overflow-hidden rounded-xl p-0 sm:max-w-[440px]"
        >
          {asset ? (
            <>
              {/* Header — 고정(scroll 영역 밖) */}
              <div className="flex shrink-0 items-center gap-[9px] px-[18px] pb-[6px] pt-[18px] text-[15px] font-[650] text-foreground">
                <span className="grid size-[30px] shrink-0 place-items-center rounded-full bg-destructive-tint text-destructive">
                  <AlertTriangle className="size-[15px]" />
                </span>
                {t('deleteTitle')}
              </div>

              {/* Body — usage list가 길면 이 영역만 내부 스크롤(footer는 항상 노출) */}
              <div className="min-h-0 flex-1 overflow-y-auto px-[18px] pb-[14px] pt-[4px] text-[13px] leading-[1.55] text-muted-foreground">
                {t.rich('deleteBody', {
                  name: asset.name,
                  b: (chunks) => <b className="font-semibold text-foreground">{chunks}</b>,
                })}

                {usageCount > 0 ? (
                  <>
                    {/* story #2590(TIER1) — tint 위 계열색 글자는 text-foreground(#2420 규칙). */}
                    <div className="mt-[10px] flex items-center gap-2 rounded-[0.5rem] bg-warning/15 px-3 py-[10px] text-[12px] font-semibold text-foreground">
                      <Link2 className="size-[15px] shrink-0" />
                      {t('deleteImpact', { count: usageCount })}
                    </div>
                    <div className="mt-[10px]">
                      <StorageSourceUsageList compact links={asset.source_links} />
                    </div>
                  </>
                ) : null}
              </div>

              {/* Footer — shrink-0로 스크롤 영역 밖에 고정, 항상 노출 */}
              <div className="flex shrink-0 justify-end gap-2 border-t border-border px-[18px] py-3">
                <DialogClose
                  render={
                    <Button variant="ghost" size="sm">
                      {t('cancel')}
                    </Button>
                  }
                />
                <Button
                  size="sm"
                  onClick={handleConfirm}
                  disabled={deleting}
                  className="bg-destructive text-white hover:bg-destructive/90"
                >
                  {t('delete')}
                </Button>
              </div>
            </>
          ) : null}
        </DialogContent>
      </Dialog>
      <ToastContainer toasts={toasts} onDismiss={dismissToast} />
    </>
  );
}
