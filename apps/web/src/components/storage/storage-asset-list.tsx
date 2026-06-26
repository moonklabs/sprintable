'use client';

import { ChevronDown, LayoutGrid, LayoutList, Plus, Search } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/ui/empty-state';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { StorageAssetRow } from './storage-asset-row';
import { StorageAssetGrid } from './storage-asset-grid';
import type { Asset, AssetSort, StorageViewMode } from '@/lib/storage/types';

interface StorageAssetListProps {
  assets: Asset[];
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
  onUpload: () => void;
  resolveFolderLabel: (folderId: string | null) => string | null;
  loading: boolean;
  error: boolean;
  onRetry: () => void;
  isSearchActive: boolean;
  hasMore: boolean;
  loadingMore: boolean;
  onLoadMore: () => void;
}

const HEADER_GRID = 'grid grid-cols-[26px_1fr_92px_78px_150px_30px] items-center gap-[10px] px-[18px]';

export function StorageAssetList({
  assets,
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
  onUpload,
  resolveFolderLabel,
  loading,
  error,
  onRetry,
  isSearchActive,
  hasMore,
  loadingMore,
  onLoadMore,
}: StorageAssetListProps) {
  const t = useTranslations('storage');

  const sortLabel: Record<AssetSort, string> = {
    date: t('sortRecent'),
    name: t('sortName'),
    size: t('sortSize'),
  };

  return (
    <section className="flex min-h-0 min-w-0 flex-col">
      {/* toolbar */}
      <div className="flex items-center gap-2 border-b border-border px-4 py-3">
        <Button size="sm" onClick={onUpload}>
          <Plus className="size-4" />
          {t('upload')}
        </Button>

        <div className="flex min-w-0 max-w-[300px] flex-1 items-center gap-[7px] rounded-[0.5rem] border border-border bg-card px-[10px] py-[7px] text-[12px] text-muted-foreground">
          <Search className="size-3.5 shrink-0 opacity-60" />
          <input
            value={search}
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder={t('searchPlaceholder')}
            className="w-full min-w-0 bg-transparent text-[12px] text-foreground outline-none placeholder:text-muted-foreground"
          />
        </div>

        <DropdownMenu>
          <DropdownMenuTrigger className="inline-flex items-center gap-1.5 rounded-[0.5rem] border border-border bg-card px-[10px] py-[7px] text-[12px] text-muted-foreground">
            {t('sortPrefix')} {sortLabel[sort]}
            <ChevronDown className="size-3.5 shrink-0 opacity-60" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuGroup>
              {(['date', 'name', 'size'] as AssetSort[]).map((option) => (
                <DropdownMenuItem key={option} onClick={() => onSortChange(option)}>
                  {sortLabel[option]}
                </DropdownMenuItem>
              ))}
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>

        <div className="flex overflow-hidden rounded-[0.5rem] border border-border">
          <button
            type="button"
            aria-label={t('viewList')}
            aria-pressed={viewMode === 'list'}
            onClick={() => onViewModeChange('list')}
            className={cn('grid size-8 place-items-center', viewMode === 'list' ? 'bg-muted text-foreground' : 'bg-card text-muted-foreground')}
          >
            <LayoutList className="size-4" />
          </button>
          <button
            type="button"
            aria-label={t('viewGrid')}
            aria-pressed={viewMode === 'grid'}
            onClick={() => onViewModeChange('grid')}
            className={cn('grid size-8 place-items-center', viewMode === 'grid' ? 'bg-muted text-foreground' : 'bg-card text-muted-foreground')}
          >
            <LayoutGrid className="size-4" />
          </button>
        </div>
      </div>

      {/* body */}
      <div className="min-h-0 flex-1 overflow-auto">
        {loading ? (
          <div className="space-y-0">
            {Array.from({ length: 8 }).map((_, i) => (
              <div key={i} className={cn(HEADER_GRID, 'h-[52px] border-b border-border')}>
                <Skeleton variant="circle" className="size-[26px]" />
                <div className="space-y-1.5">
                  <Skeleton className="h-3 w-1/2" />
                  <Skeleton className="h-2 w-1/4" />
                </div>
                <Skeleton className="h-3 w-10" />
                <Skeleton className="h-3 w-12" />
                <Skeleton className="h-3 w-24" />
                <span />
              </div>
            ))}
          </div>
        ) : error ? (
          <div className="p-6">
            <EmptyState
              title={t('errorTitle')}
              description={t('errorDesc')}
              action={
                <Button size="sm" variant="outline" onClick={onRetry}>
                  {t('retry')}
                </Button>
              }
            />
          </div>
        ) : assets.length === 0 ? (
          <div className="p-6">
            <EmptyState
              title={isSearchActive ? t('searchEmptyTitle') : t('emptyTitle')}
              description={isSearchActive ? t('searchEmptyDesc') : t('emptyDesc')}
            />
          </div>
        ) : viewMode === 'grid' ? (
          <>
            <StorageAssetGrid assets={assets} selectedAssetId={selectedAssetId} onSelect={onSelectAsset} />
            {hasMore ? (
              <div className="flex justify-center pb-4">
                <Button size="sm" variant="outline" onClick={onLoadMore} disabled={loadingMore}>
                  {t('loadMore')}
                </Button>
              </div>
            ) : null}
          </>
        ) : (
          <>
            {/* sticky header */}
            <div className={cn(HEADER_GRID, 'sticky top-0 z-10 h-[34px] border-b border-border bg-background text-[11px] font-semibold text-muted-foreground')}>
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
            {hasMore ? (
              <div className="flex justify-center py-4">
                <Button size="sm" variant="outline" onClick={onLoadMore} disabled={loadingMore}>
                  {t('loadMore')}
                </Button>
              </div>
            ) : null}
          </>
        )}
      </div>
    </section>
  );
}
