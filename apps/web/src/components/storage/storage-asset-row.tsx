'use client';

import { Link2 } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { cn } from '@/lib/utils';
import { getFileIcon } from '@/lib/file-icon';
import { formatFileSize } from '@/components/docs/extensions/file-node';
import { fileTypeTint, FILE_TINT_DS_CLASS, fileExtLabel, formatViewerRelativeTime } from '@/lib/storage/format';
import { ContextMenu, ContextMenuTrigger, Menu, MenuTrigger } from '@/components/ds/menu';
import { StorageAssetMenuContent } from './storage-asset-menu';
import { LAYER } from '@/components/ds/layers';
import { Icon } from '@/components/ds/icon';
import { StorageUploaderAvatar } from './storage-uploader-avatar';
import { StorageFileGlyph } from './storage-file-glyph';
import type { Asset } from '@/lib/storage/types';
import { useViewerTimeZone } from '@/components/viewer-time-zone';

/**
 * story #4277(PO 라이브 반려 · 유나 판정) — 목록 칸 정의 한 곳(머리 · 행 · 스켈레톤 행이 같이 쓴다 · 예전엔 행에 같은 값이 한 번 더 적혀 있었다).
 * `lg` 미만은 세 칸(아이콘 26 · 이름 블록 1fr · 메뉴 30) — 예전 여섯 칸의 고정 폭 합(462px)이 402 폭을 넘어 이름 칸(1fr)이 0px였다.
 * `lg` 이상은 예전 여섯 칸 그대로.
 */
export const ASSET_ROW_GRID =
  'grid items-center gap-[10px] px-[18px] grid-cols-[26px_1fr_30px] lg:grid-cols-[26px_1fr_92px_78px_150px_30px]';

/** 4910 — 행 얼굴(남의 글 줄과 같은 층: 내용 칸 위 `ds-surface-high`) · 마우스를 올리면 한 단 위(`ds-surface`)로. 층 규칙 시험이 이 이름을 읽는다. */
export const ASSET_ROW_FACE = LAYER.rowOthers;
/** 행을 키보드로 오갈 때 «형제 행»을 찾는 표식(↑ ↓ — 목록 몸통 안에서만). */
export const ASSET_ROW_ATTR = 'data-storage-row';

interface StorageAssetRowProps {
  asset: Asset;
  selected: boolean;
  folderLabel: string | null;
  onSelect: (asset: Asset) => void;
  onDelete: (asset: Asset) => void;
  onDownload: (asset: Asset) => void;
}

function focusSibling(row: HTMLElement, dir: 1 | -1) {
  const rows = Array.from(row.closest('[data-testid="storage-asset-list-body"]')?.querySelectorAll<HTMLElement>(`[${ASSET_ROW_ATTR}]`) ?? []);
  rows[rows.indexOf(row) + dir]?.focus();
}

export function StorageAssetRow({ asset, selected, folderLabel, onSelect, onDelete, onDownload }: StorageAssetRowProps) {
  const t = useTranslations('storage');
  const locale = useLocale();
  const displayTimezone = useViewerTimeZone(); // story #4443 PR2b — the viewer's zone (null until known)
  const ext = fileExtLabel(asset.content_type, asset.name);
  const usageCount = asset.source_links.length;
  const meta = folderLabel ? `${folderLabel} · ${ext}` : ext;

  return (
    <ContextMenu>
      <ContextMenuTrigger
        role="button"
        tabIndex={0}
        aria-pressed={selected}
        {...{ [ASSET_ROW_ATTR]: '' }}
        onClick={() => onSelect(asset)}
        // 4910 — 더블클릭 = 열기(상세 패널). 한 번 누름이 이미 고르므로 «열기»가 한 번 더 불려도 같은 결과다.
        onDoubleClick={() => onSelect(asset)}
        onKeyDown={(e) => {
          if (e.target !== e.currentTarget) return; // ⋯ 단추 · 메뉴 항목에서 올라온 키는 그쪽 몫
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onSelect(asset);
          } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            focusSibling(e.currentTarget, e.key === 'ArrowDown' ? 1 : -1);
          } else if (e.key === 'Delete' || e.key === 'Backspace') {
            e.preventDefault();
            onDelete(asset); // 삭제 확인 창이 한 번 더 묻는다(행 ⋯ 메뉴의 «삭제»와 같은 길)
          }
        }}
        className={cn(
          ASSET_ROW_GRID,
          // [SID:4380 · PO] 초점 = 제품 링(안쪽) — 배경만 바꾸던 초점은 안 보였고 고른 행의 고름 색을 덮었다(폴더 나무 행과 같은 규칙).
          'group relative min-h-ds-row cursor-pointer border-b border-ds-line py-2 text-ds-ink focus-visible:-outline-offset-2 touch:min-h-ds-touch',
          selected ? 'bg-ds-action-soft ring-1 ring-inset ring-ds-action' : cn(ASSET_ROW_FACE, 'hover:bg-ds-surface'),
        )}
      >
        {selected ? <span className="absolute inset-y-0 left-0 w-0.5 bg-ds-action" aria-hidden /> : null}

        {/* (1) 파일 아이콘 */}
        <span className={cn('grid size-[26px] shrink-0 place-items-center rounded-ds-control', FILE_TINT_DS_CLASS[fileTypeTint(asset.content_type)])}>
          <StorageFileGlyph icon={getFileIcon(asset.content_type)} className="size-[15px]" />
        </span>

        {/* (2) 이름 + 메타 */}
        <div className="min-w-0">
          <div className="truncate text-ds-body font-semibold text-ds-ink">{asset.name}</div>
          {/* story #4277(유나 판정) — `lg` 미만 둘째 줄: [사용처] · 확장자 · 크기 · 시간 · 폴더(폴더가 끝이라 먼저 잘린다). 업로더는 뺀다(상세에 있음).
              사용처는 쓰이는 곳이 있을 때만 맨 앞(없으면 안 그림). */}
          <div className="truncate text-ds-small text-ds-ink-3 lg:hidden" data-testid="storage-row-meta-mobile">
            {usageCount > 0 ? (
              <>
                <span className="font-semibold text-ds-info">
                  <Link2 className="mr-[3px] inline size-[12px] align-[-2px]" aria-hidden />
                  <span className="sr-only">{t('colUsage')} </span>
                  {t('usageCount', { count: usageCount })}
                </span>
                {' · '}
              </>
            ) : null}
            {ext} · {formatFileSize(asset.size_bytes)} · {formatViewerRelativeTime(asset.updated_at, locale, displayTimezone)}
            {folderLabel ? ` · ${folderLabel}` : ''}
          </div>
          <div className="hidden truncate text-ds-small text-ds-ink-3 lg:block">{meta}</div>
        </div>

        {/* (3) 사용처 — lg 이상 칸 */}
        {usageCount > 0 ? (
          <span className="hidden items-center gap-[5px] text-ds-small font-semibold text-ds-info lg:inline-flex">
            <Link2 className="size-[13px]" />
            {t('usageCount', { count: usageCount })}
          </span>
        ) : (
          <span className="hidden text-ds-small text-ds-ink-3 lg:inline">{t('usageNone')}</span>
        )}

        {/* (4) 크기 — lg 이상 칸 */}
        <span className="hidden text-ds-small text-ds-ink-2 lg:inline">{formatFileSize(asset.size_bytes)}</span>

        {/* (5) 업로더 · 수정 — lg 이상 칸 */}
        <div className="hidden min-w-0 items-center gap-[7px] text-ds-small text-ds-ink-2 lg:flex">
          <StorageUploaderAvatar createdBy={asset.created_by} size={22} />
          <span className="truncate">
            {asset.created_by ? `${asset.created_by.name} · ` : '· '}
            {formatViewerRelativeTime(asset.updated_at, locale, displayTimezone)}
          </span>
        </div>

        {/* (6) 케밥 — 우클릭 메뉴와 같은 항목(폰 · 키보드는 이 단추로만 닿는다: 우클릭 전용 동작 0) */}
        <div className="flex justify-end" onClick={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()} onContextMenu={(e) => e.stopPropagation()}>
          <Menu>
            <MenuTrigger
              // story #4277(유나 판정) — 행 버튼과 같은 이름이면 화면 읽기가 두 번 읽는다 → «{name} 작업».
              aria-label={t('rowActionsLabel', { name: asset.name })}
              // story #4277(유나 판정) — 기준은 폭이 아니라 «호버가 되는가»: 호버 없는 기기(폰 · 1024 이상 태블릿 가로 포함)는 늘 보이고,
              // 마우스(mouse: = 정말 올림이 되는 곳)만 예전처럼 hover · 초점 · 열림일 때 보인다.
              // 눌림 영역: 겉 크기는 26(칸 폭 30 안)이지만 ::after가 사방 9px 넓혀 44×44 — 폰 눌림 기준(행 높이 ≥ 56이라 이웃 행과 안 겹친다).
              className="relative grid size-[26px] place-items-center rounded-ds-control text-ds-ink-3 opacity-100 outline-none transition-opacity after:absolute after:-inset-[9px] after:content-[''] hover:bg-ds-surface-highest focus-visible:ring-2 focus-visible:ring-ds-action mouse:opacity-0 mouse:group-hover:opacity-100 mouse:focus-visible:opacity-100 data-[popup-open]:opacity-100"
            >
              <Icon name="more_vert" />
            </MenuTrigger>
            <StorageAssetMenuContent asset={asset} labelled onOpen={onSelect} onDownload={onDownload} onDelete={onDelete} />
          </Menu>
        </div>
      </ContextMenuTrigger>
      <StorageAssetMenuContent asset={asset} onOpen={onSelect} onDownload={onDownload} onDelete={onDelete} />
    </ContextMenu>
  );
}
