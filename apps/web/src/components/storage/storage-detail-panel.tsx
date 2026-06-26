'use client';

import { useState, type ReactNode } from 'react';
import { Download, Trash2, X } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { cn } from '@/lib/utils';
import { getFileIcon } from '@/lib/file-icon';
import { formatFileSize } from '@/components/docs/extensions/file-node';
import { fileExtLabel, formatDate, formatRelativeTime } from '@/lib/storage/format';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { StorageUploaderAvatar } from './storage-uploader-avatar';
import { StorageSourceUsageList } from './storage-source-usage-list';
import { StorageFileGlyph } from './storage-file-glyph';
import type { Asset } from '@/lib/storage/types';

interface StorageDetailPanelProps {
  asset: Asset | null;
  folderLabel: string | null;
  onDownload: (asset: Asset) => void;
  onRequestDelete: (asset: Asset) => void;
  /** drawer 모드에서 닫기 버튼 노출(데스크톱 inline 에선 미전달). */
  onClose?: () => void;
}

function MetaRow({ label, value, last = false }: { label: string; value: ReactNode; last?: boolean }) {
  return (
    <div className={cn('flex items-center justify-between py-[7px] text-[12.5px]', last ? '' : 'border-b border-dashed border-border')}>
      <span className="text-muted-foreground">{label}</span>
      <span className="flex items-center gap-1.5 font-[550] text-foreground">{value}</span>
    </div>
  );
}

export function StorageDetailPanel({ asset, folderLabel, onDownload, onRequestDelete, onClose }: StorageDetailPanelProps) {
  const t = useTranslations('storage');
  const [tab, setTab] = useState<'detail' | 'usage'>('detail');

  if (!asset) {
    return (
      <section className="flex h-full min-h-0 flex-col items-center justify-center border-l border-border bg-card p-6">
        <EmptyState title={t('selectPrompt')} className="bg-transparent" />
      </section>
    );
  }

  const ext = fileExtLabel(asset.content_type, asset.name);
  const usageCount = asset.source_links.length;

  return (
    <section className="flex h-full min-h-0 flex-col border-l border-border bg-card">
      {/* preview */}
      <div className="relative grid h-[168px] shrink-0 place-items-center border-b border-border bg-gradient-to-br from-info/10 to-brand/[0.06]">
        {onClose ? (
          <button
            type="button"
            onClick={onClose}
            aria-label={t('cancel')}
            className="absolute right-2 top-2 grid size-7 place-items-center rounded-md text-muted-foreground hover:bg-muted"
          >
            <X className="size-4" />
          </button>
        ) : null}
        <div
          className="grid size-[96px] w-[128px] place-items-center rounded-[0.5rem] text-info shadow-[0_6px_22px_oklch(0.2_0.05_258_/_0.14)]"
          style={{
            backgroundImage:
              'repeating-linear-gradient(45deg, var(--info-tint), var(--info-tint) 9px, transparent 9px, transparent 18px)',
          }}
        >
          <StorageFileGlyph icon={getFileIcon(asset.content_type)} className="size-[30px]" />
        </div>
      </div>

      {/* dhead */}
      <div className="px-4 pb-[6px] pt-[14px]">
        <div className="truncate text-[14px] font-[650] tracking-[-0.01em] text-foreground">{asset.name}</div>
        <div className="mt-[3px] text-[11.5px] text-muted-foreground">
          {ext} · {formatFileSize(asset.size_bytes)}
        </div>
      </div>

      {/* tabs (line, active border-info) */}
      <div className="flex gap-0.5 border-b border-border px-[14px] pt-[6px]">
        <button
          type="button"
          onClick={() => setTab('detail')}
          className={cn(
            '-mb-px border-b-2 px-[11px] py-2 text-[12.5px] font-semibold',
            tab === 'detail' ? 'border-info text-foreground' : 'border-transparent text-muted-foreground',
          )}
        >
          {t('tabDetail')}
        </button>
        <button
          type="button"
          onClick={() => setTab('usage')}
          className={cn(
            '-mb-px flex items-center gap-[5px] border-b-2 px-[11px] py-2 text-[12.5px] font-semibold',
            tab === 'usage' ? 'border-info text-foreground' : 'border-transparent text-muted-foreground',
          )}
        >
          {t('tabUsage')}
          <span className="rounded-full bg-info/10 px-[5px] text-[10px] font-bold text-info">{usageCount}</span>
        </button>
      </div>

      {/* body */}
      <div className="min-h-0 flex-1 overflow-auto px-4 py-[14px]">
        {tab === 'detail' ? (
          <>
            <MetaRow label={t('metaFormat')} value={asset.content_type} />
            <MetaRow label={t('metaSize')} value={formatFileSize(asset.size_bytes)} />
            <MetaRow label={t('metaFolder')} value={folderLabel ?? t('usageNone')} />
            <MetaRow
              label={t('metaUploader')}
              value={
                asset.created_by ? (
                  <>
                    <StorageUploaderAvatar createdBy={asset.created_by} size={18} />
                    {asset.created_by.name}
                  </>
                ) : (
                  <StorageUploaderAvatar createdBy={null} size={18} />
                )
              }
            />
            <MetaRow label={t('metaCreated')} value={formatDate(asset.created_at)} />
            <MetaRow label={t('metaUpdated')} value={formatRelativeTime(asset.updated_at)} last />

            {usageCount > 0 ? (
              <>
                <div className="mb-[6px] mt-[14px] text-[11px] font-bold tracking-[0.03em] text-muted-foreground">
                  {t('usageSectionLabel')}
                </div>
                <StorageSourceUsageList links={asset.source_links} />
              </>
            ) : null}
          </>
        ) : (
          <StorageSourceUsageList links={asset.source_links} />
        )}
      </div>

      {/* footer */}
      <div className="flex gap-2 border-t border-border px-4 py-3">
        <Button variant="ghost" size="sm" className="flex-1 justify-center" onClick={() => onDownload(asset)}>
          <Download className="size-4" />
          {t('download')}
        </Button>
        <Button
          variant="outline"
          size="sm"
          className="flex-1 justify-center border-destructive text-destructive hover:bg-destructive/10 hover:text-destructive"
          onClick={() => onRequestDelete(asset)}
        >
          <Trash2 className="size-4" />
          {t('delete')}
        </Button>
      </div>
    </section>
  );
}
