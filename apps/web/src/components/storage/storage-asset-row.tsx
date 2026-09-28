'use client';

import { Download, Link2, MoreVertical, Trash2 } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { cn } from '@/lib/utils';
import { getFileIcon } from '@/lib/file-icon';
import { formatFileSize } from '@/components/docs/extensions/file-node';
import { fileTypeTint, FILE_TINT_CLASS, fileExtLabel, formatRelativeTime } from '@/lib/storage/format';
import { resolveDisplayTimezone } from '@/components/content/schedule-format';
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

/**
 * story #4277(PO 라이브 반려 · 유나 판정) — 목록 칸 정의 한 곳(머리 · 행 · 스켈레톤 행이 같이 쓴다 · 예전엔 행에 같은 값이 한 번 더 적혀 있었다).
 * `lg` 미만은 세 칸(아이콘 26 · 이름 블록 1fr · 메뉴 30) — 예전 여섯 칸의 고정 폭 합(462px)이 402 폭을 넘어 이름 칸(1fr)이 0px였다.
 * `lg` 이상은 예전 여섯 칸 그대로.
 */
export const ASSET_ROW_GRID =
  'grid items-center gap-[10px] px-[18px] grid-cols-[26px_1fr_30px] lg:grid-cols-[26px_1fr_92px_78px_150px_30px]';

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
  const locale = useLocale();
  const displayTimezone = resolveDisplayTimezone().tz;
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
        ASSET_ROW_GRID,
        'group relative h-[52px] cursor-pointer border-b border-border outline-none focus-visible:bg-muted/55',
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
        {/* story #4277(유나 판정) — `lg` 미만 둘째 줄: [사용처] · 확장자 · 크기 · 시간 · 폴더(폴더가 끝이라 먼저 잘린다). 업로더는 뺀다(상세에 있음).
            사용처는 쓰이는 곳이 있을 때만 맨 앞(없으면 안 그림). */}
        <div className="truncate text-[11px] text-muted-foreground lg:hidden" data-testid="storage-row-meta-mobile">
          {usageCount > 0 ? (
            <>
              {/* tint-guard-ok: info on info/10 selected row — 아래 사용처 칸과 같은 색 */}
              <span className="font-semibold text-info">
                <Link2 className="mr-[3px] inline size-[12px] align-[-2px]" aria-hidden />
                <span className="sr-only">{t('colUsage')} </span>
                {t('usageCount', { count: usageCount })}
              </span>
              {' · '}
            </>
          ) : null}
          {ext} · {formatFileSize(asset.size_bytes)} · {formatRelativeTime(asset.updated_at, locale, displayTimezone)}
          {folderLabel ? ` · ${folderLabel}` : ''}
        </div>
        <div className="hidden truncate text-[11px] text-muted-foreground lg:block">{meta}</div>
      </div>

      {/* (3) 사용처 — lg 이상 칸 */}
      {usageCount > 0 ? (
        // tint-guard-ok: info on info/10 selected row, AA 양테마 L5.2~5.7·D4.8~5.5 @11px
        <span className="hidden items-center gap-[5px] text-[11px] font-semibold text-info lg:inline-flex">
          <Link2 className="size-[13px]" />
          {t('usageCount', { count: usageCount })}
        </span>
      ) : (
        <span className="hidden text-[11px] text-muted-foreground lg:inline">{t('usageNone')}</span>
      )}

      {/* (4) 크기 — lg 이상 칸 */}
      <span className="hidden text-[12px] text-muted-foreground lg:inline">{formatFileSize(asset.size_bytes)}</span>

      {/* (5) 업로더 · 수정 — lg 이상 칸 */}
      <div className="hidden min-w-0 items-center gap-[7px] text-[12px] text-muted-foreground lg:flex">
        <StorageUploaderAvatar createdBy={asset.created_by} size={22} />
        <span className="truncate">
          {asset.created_by ? `${asset.created_by.name} · ` : '· '}
          {formatRelativeTime(asset.updated_at, locale, displayTimezone)}
        </span>
      </div>

      {/* (6) 케밥 */}
      <div className="flex justify-end" onClick={(e) => e.stopPropagation()}>
        <DropdownMenu>
          <DropdownMenuTrigger
            // story #4277(유나 판정) — 행 버튼과 같은 이름이면 화면 읽기가 두 번 읽는다 → «{name} 작업».
            aria-label={t('rowActionsLabel', { name: asset.name })}
            // story #4277(유나 판정) — 기준은 폭이 아니라 «호버가 되는가»: 호버 없는 기기(폰 · 1024 이상 태블릿 가로 포함)는 늘 보이고,
            // 마우스(pointer-fine)만 예전처럼 hover · 초점 · 열림일 때 보인다.
            className="grid size-[26px] place-items-center rounded-sm text-muted-foreground opacity-100 transition-opacity hover:bg-muted pointer-fine:opacity-0 pointer-fine:group-hover:opacity-100 pointer-fine:focus-visible:opacity-100 data-[popup-open]:opacity-100"
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
