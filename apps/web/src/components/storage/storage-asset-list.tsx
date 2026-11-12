'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';

import { useTranslations } from 'next-intl';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ds/button';
import { IconButton } from '@/components/ds/icon-button';
import { Input } from '@/components/ds/input';
import { Skeleton } from '@/components/ds/skeleton';
import { EmptyState } from '@/components/ds/empty-state';
import { Icon } from '@/components/ds/icon';
import { LAYER } from '@/components/ds/layers';
import { Menu, MenuContent, MenuGroup, MenuItem, MenuTrigger } from '@/components/ds/menu';
import { ASSET_ROW_GRID, StorageAssetRow } from './storage-asset-row';
import { StorageAssetGrid } from './storage-asset-grid';
import type { Asset, AssetSort, StorageViewMode } from '@/lib/storage/types';

interface StorageAssetListProps {
  assets: Asset[];
  /** 머리 줄의 «N개 자산 · 용량» — 제목은 위 막대 한 곳이라 개수가 본문 머리로 내려왔다(4910 · 4913 규칙). */
  summaryText: string;
  viewMode: StorageViewMode;
  onViewModeChange: (mode: StorageViewMode) => void;
  search: string;
  onSearchChange: (value: string) => void;
  sort: AssetSort;
  onSortChange: (sort: AssetSort) => void;
  selectedAssetId: string | null;
  onSelectAsset: (asset: Asset) => void;
  onDeleteAsset: (asset: Asset) => void;
  onDownloadAsset: (asset: Asset) => void;
  /** 파일 하나를 올린다(단추로 고른 파일 · 창에 끌어 놓은 파일 모두 «파일마다 한 번» 이 길로 간다). */
  onUploadFile: (file: File) => void | Promise<void>;
  resolveFolderLabel: (folderId: string | null) => string | null;
  loading: boolean;
  error: boolean;
  onRetry: () => void;
  isSearchActive: boolean;
  hasMore: boolean;
  loadingMore: boolean;
  onLoadMore: () => void;
  /** 4910 — 왼쪽 폴더 나무(lg 이상). 머리 줄 · 필터 줄 «아래», 목록 «옆»에 서서 한 장의 내용 칸 안에 들어간다. */
  sidebar?: ReactNode;
}

// story #4277 — 칸 정의는 행과 한 상수(ASSET_ROW_GRID · storage-asset-row.tsx).

/** 끌어 온 것이 «파일»인가(글 · 링크 끌기에는 안 반응한다). */
function dragHasFiles(e: DragEvent): boolean {
  return Array.from(e.dataTransfer?.types ?? []).includes('Files');
}

/**
 * 이 끌어 놓기가 «스토리지 올리기» 몫인가 — 창 전체에서 듣기 때문에 다른 놓을 자리를 가로채지 않게 가른다(codex 1차):
 *  · 글 칸(input · textarea · 글 편집기) 위 · 대화 상자 안 → 그쪽 몫(폴더 이름 칸에 파일을 놓아도 올라가면 안 된다)
 *  · 열려 있는 모달(삭제 확인 등)이 있으면 그 뒤 화면은 눌리지 않는 때 — 올리기도 막는다
 *  · 이미 누가 처리했으면(`defaultPrevented`) 건드리지 않는다
 */
const OTHER_DROP_TARGET = 'input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="dialog"], [role="alertdialog"]';
export function dropBelongsToStorage(e: DragEvent): boolean {
  if (e.defaultPrevented || !dragHasFiles(e)) return false;
  const target = e.target instanceof Element ? e.target : null;
  if (target?.closest(OTHER_DROP_TARGET)) return false;
  const openModal = Array.from(document.querySelectorAll('[role="dialog"][aria-modal="true"], [role="alertdialog"]'))
    .some((d) => d.getAttribute('aria-hidden') !== 'true' && !d.hasAttribute('inert'));
  return !openModal;
}

/** 파일을 «한 번에 하나씩 차례로» 올린다 — 같은 올리기 길(`onUploadFile`)을 파일마다 한 번(동시에 쏟지 않는다). */
export async function uploadFilesOneByOne(files: ArrayLike<File>, upload: (file: File) => void | Promise<void>): Promise<void> {
  for (const file of Array.from(files)) await upload(file);
}

export function StorageAssetList({
  assets,
  summaryText,
  viewMode,
  onViewModeChange,
  search,
  onSearchChange,
  sort,
  onSortChange,
  selectedAssetId,
  onSelectAsset,
  onDeleteAsset,
  onDownloadAsset,
  onUploadFile,
  resolveFolderLabel,
  loading,
  error,
  onRetry,
  isSearchActive,
  hasMore,
  loadingMore,
  onLoadMore,
  sidebar,
}: StorageAssetListProps) {
  const t = useTranslations('storage');
  const fileInputRef = useRef<HTMLInputElement>(null);
  const uploadRef = useRef(onUploadFile);
  useEffect(() => { uploadRef.current = onUploadFile; });

  // 4910 — 창에 파일을 끌어 놓으면 «업로드» 단추와 같은 올리기가 파일마다 한 번. 놓는 동안 점선 틀 + 한 줄 안내.
  // 깊이 세기: dragenter/leave는 자식 요소를 오갈 때마다 짝으로 불린다 — 0이 될 때만 «떠남».
  const [dragCount, setDragCount] = useState<number | null>(null);
  useEffect(() => {
    let depth = 0;
    const onEnter = (e: DragEvent) => {
      if (!dropBelongsToStorage(e)) return;
      depth += 1;
      setDragCount(e.dataTransfer?.items.length ?? 0);
    };
    const onOver = (e: DragEvent) => {
      if (dropBelongsToStorage(e)) e.preventDefault(); // 놓기를 받는다는 표시(없으면 브라우저가 파일을 «열어» 버린다)
    };
    const onLeave = (e: DragEvent) => {
      if (!dragHasFiles(e)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) setDragCount(null);
    };
    const onDrop = (e: DragEvent) => {
      if (!dropBelongsToStorage(e)) {
        depth = 0;
        setDragCount(null);
        return;
      }
      e.preventDefault();
      depth = 0;
      setDragCount(null);
      void uploadFilesOneByOne(e.dataTransfer?.files ?? [], (f) => uploadRef.current(f));
    };
    window.addEventListener('dragenter', onEnter);
    window.addEventListener('dragover', onOver);
    window.addEventListener('dragleave', onLeave);
    window.addEventListener('drop', onDrop);
    return () => {
      window.removeEventListener('dragenter', onEnter);
      window.removeEventListener('dragover', onOver);
      window.removeEventListener('dragleave', onLeave);
      window.removeEventListener('drop', onDrop);
    };
  }, []);

  const sortLabel: Record<AssetSort, string> = {
    date: t('sortRecent'),
    name: t('sortName'),
    size: t('sortSize'),
  };

  return (
    <section className={cn('relative flex h-full min-h-0 min-w-0 flex-col', LAYER.panel)} data-testid="storage-asset-list">
      {/* 머리 줄 — «N개 자산 · 용량» + 주 행동(업로드). 제목은 위 막대 한 곳. */}
      <div className="flex items-center gap-3 border-b border-ds-line px-4 py-3" data-testid="storage-head">
        <p className="m-0 min-w-0 truncate text-ds-body font-semibold text-ds-ink-2" data-testid="storage-summary" title={summaryText}>
          {summaryText}
        </p>
        <span className="flex-1" />
        <Button variant="primary" iconStart={<Icon name="upload" size={14} />} onClick={() => fileInputRef.current?.click()}>
          {t('upload')}
        </Button>
        {/* story #886d996f — 업로드 트리거용 hidden file input. 4910: 여러 파일을 한 번에 고르면 파일마다 한 번씩 차례로 올린다.
            value 리셋으로 같은 파일 재선택 가능. */}
        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="hidden"
          onChange={(e) => {
            const files = e.target.files ? Array.from(e.target.files) : [];
            e.target.value = '';
            void uploadFilesOneByOne(files, (f) => uploadRef.current(f));
          }}
        />
      </div>

      {/* 필터 한 줄 — 검색 · 정렬 · 보기 */}
      <div className="flex flex-wrap items-center gap-2 border-b border-ds-line px-4 py-2.5" data-testid="storage-filters">
        <Input
          type="search"
          value={search}
          onChange={(e) => onSearchChange(e.target.value)}
          placeholder={t('searchPlaceholder')}
          aria-label={t('searchPlaceholder')}
          // 폰(390): 검색칸이 줄 전체를 쓰고 정렬 · 보기는 아래 줄로 — 한 줄에 다 넣으면 검색칸이 글자 하나 폭(실측 «이름»)으로 쪼그라든다. sm 이상은 한 줄.
          className="min-w-0 basis-full sm:max-w-[300px] sm:flex-1 sm:basis-auto"
        />

        <Menu>
          <MenuTrigger className="inline-flex h-ds-control-sm shrink-0 items-center gap-1.5 rounded-ds-control border border-ds-line-control px-2.5 text-ds-small text-ds-ink-2 outline-none hover:bg-ds-surface-high focus-visible:ring-2 focus-visible:ring-ds-action touch:min-h-ds-touch">
            {t('sortPrefix')} {sortLabel[sort]}
            <Icon name="expand_more" size={14} />
          </MenuTrigger>
          <MenuContent align="end">
            <MenuGroup>
              {(['date', 'name', 'size'] as AssetSort[]).map((option) => (
                <MenuItem key={option} onClick={() => onSortChange(option)}>
                  {sortLabel[option]}
                </MenuItem>
              ))}
            </MenuGroup>
          </MenuContent>
        </Menu>

        <span className="hidden flex-1 sm:block" />
        <div className="ml-auto flex shrink-0 overflow-hidden rounded-ds-control border border-ds-line-control sm:ml-0">
          <IconButton
            label={t('viewList')}
            icon="view_list"
            aria-pressed={viewMode === 'list'}
            onClick={() => onViewModeChange('list')}
            className={cn('rounded-none', viewMode === 'list' && 'bg-ds-action-soft text-ds-action-text')}
          />
          <IconButton
            label={t('viewGrid')}
            icon="grid_view"
            aria-pressed={viewMode === 'grid'}
            onClick={() => onViewModeChange('grid')}
            className={cn('rounded-none', viewMode === 'grid' && 'bg-ds-action-soft text-ds-action-text')}
          />
        </div>
      </div>

      <div className="flex min-h-0 flex-1">
        {sidebar ? <div className="hidden w-[248px] shrink-0 lg:flex" data-testid="storage-folder-tree-column">{sidebar}</div> : null}
      {/* body */}
      {/* story #4277 — e2e가 행 출현을 기다리지 않고 «다 불러온 뒤 한 번 세도록» 지금 상태를 싣는다(행 0이면 즉시 건너뜀). */}
      <div
        className="focus-inset min-h-0 min-w-0 flex-1 overflow-auto p-4"
        data-testid="storage-asset-list-body"
        data-state={loading ? 'loading' : error ? 'error' : assets.length === 0 ? 'empty' : 'rows'}
      >
        {loading ? (
          <div className="overflow-hidden rounded-ds-panel border border-ds-line">
            {Array.from({ length: 8 }).map((_, i) => (
              <div key={i} className={cn(ASSET_ROW_GRID, LAYER.rowOthers, 'min-h-ds-row border-b border-ds-line py-2')}>
                <Skeleton variant="circle" className="size-[26px]" />
                <div className="space-y-1.5">
                  <Skeleton className="h-3 w-1/2" />
                  <Skeleton className="h-2 w-1/4" />
                </div>
                {/* 행과 같은 모양 — lg 미만은 세 칸(사용처 · 크기 · 업로더 칸 없음). */}
                <Skeleton className="hidden h-3 w-10 lg:block" />
                <Skeleton className="hidden h-3 w-12 lg:block" />
                <Skeleton className="hidden h-3 w-24 lg:block" />
                <span />
              </div>
            ))}
          </div>
        ) : error ? (
          <EmptyState
            title={t('errorTitle')}
            description={t('errorDesc')}
            action={
              <Button onClick={onRetry}>
                {t('retry')}
              </Button>
            }
          />
        ) : assets.length === 0 ? (
          <EmptyState
            title={isSearchActive ? t('searchEmptyTitle') : t('emptyTitle')}
            description={isSearchActive ? t('searchEmptyDesc') : t('emptyDesc')}
          />
        ) : viewMode === 'grid' ? (
          <>
            <StorageAssetGrid assets={assets} selectedAssetId={selectedAssetId} onSelect={onSelectAsset} onDelete={onDeleteAsset} onDownload={onDownloadAsset} />
            {hasMore ? (
              <div className="flex justify-center pt-4">
                <Button onClick={onLoadMore} disabled={loadingMore}>
                  {t('loadMore')}
                </Button>
              </div>
            ) : null}
          </>
        ) : (
          <>
            <div className="overflow-hidden rounded-ds-panel border border-ds-line">
              {/* story #4277(유나 판정) — 머리 줄은 lg 이상만(lg 미만은 한 칸짜리 두 줄 행 · 정렬은 툴바 메뉴). */}
              <div className={cn(ASSET_ROW_GRID, 'sticky top-0 z-10 hidden min-h-ds-compact border-b border-ds-line bg-ds-surface-highest text-ds-small font-semibold text-ds-ink-2 lg:grid')}>
                <span />
                <span>{t('colName')}</span>
                <span>{t('colUsage')}</span>
                <span>{t('colSize')}</span>
                <span>{t('colOwner')}</span>
                <span />
              </div>
              {assets.map((asset) => (
                <StorageAssetRow
                  key={asset.id}
                  asset={asset}
                  selected={asset.id === selectedAssetId}
                  folderLabel={resolveFolderLabel(asset.folder_id)}
                  onSelect={onSelectAsset}
                  onDelete={onDeleteAsset}
                  onDownload={onDownloadAsset}
                />
              ))}
            </div>
            {hasMore ? (
              <div className="flex justify-center pt-4">
                <Button onClick={onLoadMore} disabled={loadingMore}>
                  {t('loadMore')}
                </Button>
              </div>
            ) : null}
          </>
        )}
      </div>
      </div>

      {dragCount !== null ? (
        <div
          data-testid="storage-drop-overlay"
          role="status"
          className="pointer-events-none absolute inset-2 z-20 flex items-center justify-center rounded-ds-panel border-2 border-dashed border-ds-action bg-ds-action-soft/80 text-ds-body font-semibold text-ds-action-text"
        >
          {dragCount > 0 ? t('dropHint', { count: dragCount }) : t('dropHintAny')}
        </div>
      ) : null}
    </section>
  );
}
