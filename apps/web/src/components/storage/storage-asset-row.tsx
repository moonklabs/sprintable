'use client';

import { Download, Link2, MoreVertical, Trash2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { cn } from '@/lib/utils';
import { getFileIcon } from '@/lib/file-icon';
import { formatFileSize } from '@/components/docs/extensions/file-node';
import { fileTypeTint, FILE_TINT_CLASS, fileExtLabel, formatRelativeTime } from '@/lib/storage/format';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { StorageUploaderAvatar } from './storage-uploader-avatar';
import { StorageFileGlyph } from './storage-file-glyph';
import type { Asset } from '@/lib/storage/types';

interface StorageAssetRowProps {
  asset: Asset;
  selected: boolean;
  folderLabel: string | null;
  onSelect: (asset: Asset) => void;
  onDelete: (asset: Asset) => void;
  onDownload: (asset: Asset) => void;
}

export function StorageAssetRow({ asset, selected, folderLabel, onSelect, onDelete, onDownload }: StorageAssetRowProps) {
  const t = useTranslations('storage');
  const ext = fileExtLabel(asset.content_type, asset.name);
  const usageCount = asset.source_links.length;
  const meta = folderLabel ? `${folderLabel} · ${ext}` : ext;

  return (
    <div
      role="button"
      tabIndex={0}
      aria-pressed={selected}
      onClick={() => onSelect(asset)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onSelect(asset);
        }
      }}
      className={cn(
        'group relative grid h-[52px] cursor-pointer grid-cols-[26px_1fr_92px_78px_150px_30px] items-center gap-[10px] border-b border-border px-[18px] outline-none focus-visible:bg-muted/55',
        selected ? 'bg-info/10' : 'hover:bg-muted/55',
      )}
    >
      {selected ? <span className="absolute left-0 top-0 h-[52px] w-0.5 bg-info" aria-hidden /> : null}

      {/* (1) 파일 아이콘 */}
      <span className={cn('grid size-[26px] shrink-0 place-items-center rounded-sm', FILE_TINT_CLASS[fileTypeTint(asset.content_type)])}>
        <StorageFileGlyph icon={getFileIcon(asset.content_type)} className="size-[15px]" />
      </span>

      {/* (2) 이름 + 메타 */}
      <div className="min-w-0">
        <div className="truncate text-[13px] font-[550] text-foreground">{asset.name}</div>
        <div className="truncate text-[11px] text-muted-foreground">{meta}</div>
      </div>

      {/* (3) 사용처 */}
      {usageCount > 0 ? (
        <span className="inline-flex items-center gap-[5px] text-[11px] font-semibold text-info">
          <Link2 className="size-[13px]" />
          {t('usageCount', { count: usageCount })}
        </span>
      ) : (
        <span className="text-[11px] text-muted-foreground">{t('usageNone')}</span>
      )}

      {/* (4) 크기 */}
      <span className="text-[12px] text-muted-foreground">{formatFileSize(asset.size_bytes)}</span>

      {/* (5) 업로더 · 수정 */}
      <div className="flex min-w-0 items-center gap-[7px] text-[12px] text-muted-foreground">
        <StorageUploaderAvatar createdBy={asset.created_by} size={22} />
        <span className="truncate">
          {asset.created_by ? `${asset.created_by.name} · ` : '· '}
          {formatRelativeTime(asset.updated_at)}
        </span>
      </div>

      {/* (6) 케밥 */}
      <div className="flex justify-end" onClick={(e) => e.stopPropagation()}>
        <DropdownMenu>
          <DropdownMenuTrigger
            aria-label={asset.name}
            className="grid size-[26px] place-items-center rounded-sm text-muted-foreground opacity-0 transition-opacity hover:bg-muted focus-visible:opacity-100 group-hover:opacity-100 data-[popup-open]:opacity-100"
          >
            <MoreVertical className="size-4" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuGroup>
              <DropdownMenuLabel className="max-w-[200px] truncate">{asset.name}</DropdownMenuLabel>
              <DropdownMenuItem onClick={() => onDownload(asset)}>
                <Download className="size-4" />
                {t('download')}
              </DropdownMenuItem>
              <DropdownMenuItem variant="destructive" onClick={() => onDelete(asset)}>
                <Trash2 className="size-4" />
                {t('delete')}
              </DropdownMenuItem>
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}
