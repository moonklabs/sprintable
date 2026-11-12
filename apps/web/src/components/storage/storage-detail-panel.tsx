'use client';

import { useState, type ReactNode } from 'react';
import { Download, Trash2, X } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { cn } from '@/lib/utils';
import { getFileIcon } from '@/lib/file-icon';
import { formatFileSize } from '@/components/docs/extensions/file-node';
import { fileExtLabel, formatDate, formatViewerRelativeTime } from '@/lib/storage/format';
import { Button } from '@/components/ds/button';
import { EmptyState } from '@/components/ds/empty-state';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { StorageUploaderAvatar } from './storage-uploader-avatar';
import { StorageSourceUsageList } from './storage-source-usage-list';
import { StorageFileGlyph } from './storage-file-glyph';
import { StorageThumbnail } from './storage-thumbnail';
import type { Asset } from '@/lib/storage/types';
import { useViewerTimeZone } from '@/components/viewer-time-zone';

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
    <div className={cn('flex items-center justify-between py-[7px] text-[12.5px]', last ? '' : 'border-b border-dashed border-ds-line')}>
      <span className="text-ds-ink-3">{label}</span>
      <span className="flex items-center gap-1.5 font-[550] text-ds-ink">{value}</span>
    </div>
  );
}

export function StorageDetailPanel({ asset, folderLabel, onDownload, onRequestDelete, onClose }: StorageDetailPanelProps) {
  const t = useTranslations('storage');
  const locale = useLocale();
  const displayTimezone = useViewerTimeZone(); // story #4443 PR2b — the viewer's zone (null until known)
  const [tab, setTab] = useState<'detail' | 'usage'>('detail');

  if (!asset) {
    return (
      <section className="flex h-full min-h-0 flex-col items-center justify-center border-l border-ds-line bg-ds-surface p-6">
        <EmptyState title={t('selectPrompt')} className="bg-transparent" />
      </section>
    );
  }

  const ext = fileExtLabel(asset.content_type, asset.name);
  const usageCount = asset.source_links.length;
  const isImage = asset.content_type.startsWith('image/');

  return (
    <section className="flex h-full min-h-0 flex-col border-l border-ds-line bg-ds-surface">
      {/* preview */}
      <div className="relative grid h-[168px] shrink-0 place-items-center overflow-hidden border-b border-ds-line bg-ds-surface-highest">
        {isImage ? (
          <StorageThumbnail key={asset.id} asset={asset} />
        ) : (
          <div
            className="grid size-[96px] w-[128px] place-items-center rounded-[0.5rem] text-ds-info shadow-lg"
            style={{
              backgroundImage:
                'repeating-linear-gradient(45deg, var(--ds-info-soft), var(--ds-info-soft) 9px, transparent 9px, transparent 18px)',
            }}
          >
            <StorageFileGlyph icon={getFileIcon(asset.content_type)} className="size-[30px]" />
          </div>
        )}
        {onClose ? (
          <button
            type="button"
            onClick={onClose}
            aria-label={t('cancel')}
            className="absolute right-2 top-2 z-10 grid size-7 place-items-center rounded-md bg-ds-surface/70 text-ds-ink-3 backdrop-blur-sm hover:bg-ds-surface-high"
          >
            <X className="size-4" />
          </button>
        ) : null}
      </div>

      {/* dhead */}
      <div className="px-4 pb-[6px] pt-[14px]">
        <div className="truncate text-[14px] font-[650] tracking-[-0.01em] text-ds-ink">{asset.name}</div>
        <div className="mt-[3px] text-[11.5px] text-ds-ink-3">
          {ext} · {formatFileSize(asset.size_bytes)}
        </div>
      </div>

      {/* tabs — [SID:4388] shared line tabs: arrow keys · Home/End move and select (activateOnFocus), aria-selected comes with it.
          The body is the tab panel (role=tabpanel · named by its tab · a focus stop, so Tab reaches it); `contents` keeps the layout.
          The shared TabsContent sets text-sm, whose line-height ratio (1.25/0.875) is below the inherited 1.5: the 12.5px meta rows
          each came out 0.91px shorter (5.44px over six rows, Chromium). The panels inherit font-size and line-height instead. */}
      <Tabs value={tab} onValueChange={(v) => setTab(v as 'detail' | 'usage')} className="contents">
      <div className="border-b border-ds-line px-[14px] pt-[6px] pb-[5px]">
        <TabsList variant="line" activateOnFocus>
          <TabsTrigger value="detail">{t('tabDetail')}</TabsTrigger>
          <TabsTrigger value="usage">
            {t('tabUsage')}
            {/* story #2590(TIER3) — tint 위 계열색 글자는 text-ds-ink(#2420 규칙). */}
            <span className="rounded-full bg-ds-action-soft px-[5px] text-[10px] font-bold text-ds-ink">{usageCount}</span>
          </TabsTrigger>
        </TabsList>
      </div>

      {/* body */}
      <div className="min-h-0 flex-1 overflow-auto px-4 py-[14px]">
        <TabsContent value="detail" className="rounded-sm text-[length:inherit] leading-[inherit] focus-visible:ring-2 focus-visible:ring-ds-action">
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
            <MetaRow label={t('metaCreated')} value={formatDate(asset.created_at, displayTimezone)} />
            <MetaRow label={t('metaUpdated')} value={formatViewerRelativeTime(asset.updated_at, locale, displayTimezone)} last />

            {usageCount > 0 ? (
              <>
                <div className="mb-[6px] mt-[14px] text-[11px] font-bold tracking-[0.03em] text-ds-ink-3">
                  {t('usageSectionLabel')}
                </div>
                <StorageSourceUsageList links={asset.source_links} />
              </>
            ) : null}
        </TabsContent>
        <TabsContent value="usage" className="rounded-sm text-[length:inherit] leading-[inherit] focus-visible:ring-2 focus-visible:ring-ds-action">
          <StorageSourceUsageList links={asset.source_links} />
        </TabsContent>
      </div>
      </Tabs>

      {/* footer */}
      <div className="flex gap-2 border-t border-ds-line px-4 py-3">
        <Button variant="quiet" className="flex-1 justify-center" onClick={() => onDownload(asset)}>
          <Download className="size-4" />
          {t('download')}
        </Button>
        <Button variant="danger" className="flex-1 justify-center" onClick={() => onRequestDelete(asset)}>
          <Trash2 className="size-4" />
          {t('delete')}
        </Button>
      </div>
    </section>
  );
}
