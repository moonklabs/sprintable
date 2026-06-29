'use client';

import { Link2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { cn } from '@/lib/utils';
import { getFileIcon } from '@/lib/file-icon';
import { formatFileSize } from '@/components/docs/extensions/file-node';
import { fileTypeTint, FILE_TINT_CLASS } from '@/lib/storage/format';
import { StorageUploaderAvatar } from './storage-uploader-avatar';
import type { Asset } from '@/lib/storage/types';

interface StorageAssetGridProps {
  assets: Asset[];
  selectedAssetId: string | null;
  onSelect: (asset: Asset) => void;
}

export function StorageAssetGrid({ assets, selectedAssetId, onSelect }: StorageAssetGridProps) {
  const t = useTranslations('storage');

  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-3 p-[18px]">
      {assets.map((asset) => {
        const Icon = getFileIcon(asset.content_type);
        const usageCount = asset.source_links.length;
        const selected = asset.id === selectedAssetId;

        return (
          <button
            key={asset.id}
            type="button"
            onClick={() => onSelect(asset)}
            aria-pressed={selected}
            className={cn(
              'group flex flex-col overflow-hidden rounded-[0.5rem] border bg-card text-left transition-colors',
              selected ? 'border-info ring-1 ring-info/40' : 'border-border hover:bg-muted/40',
            )}
          >
            <div className="grid h-[112px] place-items-center bg-gradient-to-br from-info/10 to-brand/[0.06]">
              <span className={cn('grid size-12 place-items-center rounded-[0.5rem]', FILE_TINT_CLASS[fileTypeTint(asset.content_type)])}>
                <Icon className="size-6" />
              </span>
            </div>
            <div className="flex flex-col gap-1.5 p-2.5">
              <div className="truncate text-[12.5px] font-[550] text-foreground">{asset.name}</div>
              <div className="flex items-center justify-between">
                {usageCount > 0 ? (
                  <span className="inline-flex items-center gap-[5px] text-[11px] font-semibold text-info">
                    <Link2 className="size-[13px]" />
                    {t('usageCount', { count: usageCount })}
                  </span>
                ) : (
                  <span className="text-[11px] text-muted-foreground">{formatFileSize(asset.size_bytes)}</span>
                )}
                <StorageUploaderAvatar createdBy={asset.created_by} size={20} />
              </div>
            </div>
          </button>
        );
      })}
    </div>
  );
}
