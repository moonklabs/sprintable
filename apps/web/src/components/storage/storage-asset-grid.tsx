'use client';

import { Link2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { cn } from '@/lib/utils';
import { getFileIcon } from '@/lib/file-icon';
import { formatFileSize } from '@/components/docs/extensions/file-node';
import { fileTypeTint, FILE_TINT_DS_CLASS } from '@/lib/storage/format';
import { ContextMenu, ContextMenuTrigger } from '@/components/ds/menu';
import { LAYER } from '@/components/ds/layers';
import { StorageAssetMenuContent } from './storage-asset-menu';
import { StorageUploaderAvatar } from './storage-uploader-avatar';
import type { Asset } from '@/lib/storage/types';

interface StorageAssetGridProps {
  assets: Asset[];
  selectedAssetId: string | null;
  onSelect: (asset: Asset) => void;
  onDelete: (asset: Asset) => void;
  onDownload: (asset: Asset) => void;
}

/** 카드 얼굴 = 행과 같은 층(내용 칸 위 `ds-surface-high`), 그림 칸 = 한 단 위 `ds-surface-highest`(층 규칙 · 4910). */
export const ASSET_CARD_FACE = LAYER.rowOthers;
export const ASSET_CARD_WELL = LAYER.well;

export function StorageAssetGrid({ assets, selectedAssetId, onSelect, onDelete, onDownload }: StorageAssetGridProps) {
  const t = useTranslations('storage');

  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-3" data-testid="storage-asset-grid">
      {assets.map((asset) => {
        const Icon = getFileIcon(asset.content_type);
        const usageCount = asset.source_links.length;
        const selected = asset.id === selectedAssetId;

        return (
          <ContextMenu key={asset.id}>
            <ContextMenuTrigger
              // 이름 = 파일 이름(카드 안 글은 사용처 수 · 용량 · 올린 사람이라 이름에 섞이지 않게) — 카드마다 다른 이름.
              render={<button type="button" aria-label={asset.name} />}
              onClick={() => onSelect(asset)}
              onDoubleClick={() => onSelect(asset)}
              onKeyDown={(e: React.KeyboardEvent<HTMLElement>) => {
                if (e.key === 'Delete' || e.key === 'Backspace') {
                  e.preventDefault();
                  onDelete(asset);
                } else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft' || e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                  const cards = Array.from(e.currentTarget.parentElement?.querySelectorAll<HTMLElement>(':scope > button') ?? []);
                  const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : -1;
                  const next = cards[cards.indexOf(e.currentTarget) + step];
                  if (next) {
                    e.preventDefault();
                    next.focus();
                  }
                }
              }}
              aria-pressed={selected}
              className={cn(
                'group flex min-h-ds-touch flex-col overflow-hidden rounded-ds-panel border text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ds-action',
                selected ? 'border-ds-action bg-ds-action-soft' : cn('border-ds-line hover:bg-ds-surface', ASSET_CARD_FACE),
              )}
            >
              <div className={cn('grid h-[112px] place-items-center', ASSET_CARD_WELL)}>
                <span className={cn('grid size-12 place-items-center rounded-ds-control', FILE_TINT_DS_CLASS[fileTypeTint(asset.content_type)])}>
                  <Icon className="size-6" />
                </span>
              </div>
              <div className="flex flex-col gap-1.5 p-2.5">
                <div className="truncate text-ds-body font-semibold text-ds-ink">{asset.name}</div>
                <div className="flex items-center justify-between">
                  {usageCount > 0 ? (
                    <span className="inline-flex items-center gap-[5px] text-ds-small font-semibold text-ds-info">
                      <Link2 className="size-[13px]" />
                      {t('usageCount', { count: usageCount })}
                    </span>
                  ) : (
                    <span className="text-ds-small text-ds-ink-3">{formatFileSize(asset.size_bytes)}</span>
                  )}
                  <StorageUploaderAvatar createdBy={asset.created_by} size={20} />
                </div>
              </div>
            </ContextMenuTrigger>
            <StorageAssetMenuContent asset={asset} onOpen={onSelect} onDownload={onDownload} onDelete={onDelete} />
          </ContextMenu>
        );
      })}
    </div>
  );
}
