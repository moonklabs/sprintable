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
      // S7(서버 delete) 미착지 가능 → 비-2xx/예외는 toast 후 graceful 유지.
      const res = await fetch(`/api/assets/${asset.id}`, { method: 'DELETE' });
      if (!res.ok) {
        addToast({ title: t('errorTitle'), body: t('errorDesc'), type: 'error' });
        return;
      }
      onDeleted(asset.id);
      onOpenChange(false);
    } catch {
      addToast({ title: t('errorTitle'), body: t('errorDesc'), type: 'error' });
    } finally {
      setDeleting(false);
    }
  }

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent
          showCloseButton={false}
          className="w-[440px] max-w-[calc(100%-2rem)] gap-0 overflow-hidden rounded-xl p-0 sm:max-w-[440px]"
        >
          {asset ? (
            <>
              {/* Header */}
              <div className="flex items-center gap-[9px] px-[18px] pb-[6px] pt-[18px] text-[15px] font-[650] text-foreground">
                <span className="grid size-[30px] shrink-0 place-items-center rounded-full bg-destructive/10 text-destructive">
                  <AlertTriangle className="size-[15px]" />
                </span>
                {t('deleteTitle')}
              </div>

              {/* Body */}
              <div className="px-[18px] pb-[14px] pt-[4px] text-[13px] leading-[1.55] text-muted-foreground">
                {t.rich('deleteBody', {
                  name: () => <b className="font-semibold text-foreground">{asset.name}</b>,
                })}

                {usageCount > 0 ? (
                  <>
                    <div className="mt-[10px] flex items-center gap-2 rounded-[0.5rem] bg-warning/15 px-3 py-[10px] text-[12px] font-semibold text-warning">
                      <Link2 className="size-[15px] shrink-0" />
                      {t('deleteImpact', { count: usageCount })}
                    </div>
                    <div className="mt-[10px]">
                      <StorageSourceUsageList compact links={asset.source_links} />
                    </div>
                  </>
                ) : null}
              </div>

              {/* Footer */}
              <div className="flex justify-end gap-2 border-t border-border px-[18px] py-3">
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
