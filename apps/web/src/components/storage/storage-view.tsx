'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { cn } from '@/lib/utils';
import { TopBarSlot } from '@/components/nav/top-bar-slot';
import { Badge } from '@/components/ui/badge';
import { useContextualPanelState } from '@/components/ui/contextual-panel-layout';
import { useDashboardContext } from '@/app/dashboard/dashboard-shell';
import { useFocusTrap } from '@/hooks/use-focus-trap';
import { formatTotalSize } from '@/lib/storage/format';
import { StorageCapacityBanner } from './storage-capacity-banner';
import { StorageFolderTree } from './storage-folder-tree';
import { StorageAssetList } from './storage-asset-list';
import { StorageDetailPanel } from './storage-detail-panel';
import { StorageDeleteDialog } from './storage-delete-dialog';
import type {
  Asset,
  AssetListResponse,
  AssetSort,
  Folder,
  SortOrder,
  StorageViewMode,
} from '@/lib/storage/types';

// story a539c649 S3a/b: projectId 는 이제 page.tsx(headers() 경유 resolve 결과)가 prop 으로
// 내려준다 — useDashboardContext()(전역 "현재 프로젝트")가 아니라 URL 이 가리키는 project.
// projectName 은 순수 표시용(폴더 트리 헤더)이라 전역 컨텍스트 그대로 유지(artifacts와 동형).
export function StorageView({ projectId }: { projectId: string }) {
  const t = useTranslations('storage');
  const { projectName } = useDashboardContext();

  const [folders, setFolders] = useState<Folder[]>([]);
  const [items, setItems] = useState<Asset[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [nextCursor, setNextCursor] = useState<string | null>(null);

  const [selectedFolderId, setSelectedFolderId] = useState<string | null>(null);
  const [selectedAssetId, setSelectedAssetId] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<StorageViewMode>('list');
  const [sort, setSort] = useState<AssetSort>('date');
  const [order, setOrder] = useState<SortOrder>('desc');

  const [search, setSearch] = useState('');
  const [effectiveSearch, setEffectiveSearch] = useState('');
  const [folderSearch, setFolderSearch] = useState('');

  const [assetToDelete, setAssetToDelete] = useState<Asset | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);

  const detailPanel = useContextualPanelState({ storageKey: 'storage-detail', defaultOpen: true });
  // story #2061 — role/aria-modal은 있었지만 포커스 트랩·Esc·반환이 없던 손수구현 드로어.
  const { setDrawerOpen: setDetailDrawerOpen } = detailPanel;
  const detailDrawerTrapRef = useFocusTrap(
    !detailPanel.supportsInlinePanel && detailPanel.drawerOpen,
    useCallback(() => setDetailDrawerOpen(false), [setDetailDrawerOpen]),
  );
  const reqIdRef = useRef(0);

  // 검색 디바운스
  useEffect(() => {
    const id = setTimeout(() => setEffectiveSearch(search.trim()), 250);
    return () => clearTimeout(id);
  }, [search]);

  // 폴더 fetch
  useEffect(() => {
    if (!projectId) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(`/api/folders?project_id=${encodeURIComponent(projectId)}`);
        if (!res.ok) return;
        const json = (await res.json()) as { data?: Folder[] };
        if (!cancelled) setFolders(json.data ?? []);
      } catch {
        // 폴더 로드 실패는 치명적이지 않음 — 트리 비움
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  // story #1939: 루트 레벨 폴더 생성. BE는 raw FastAPI 에러 바디({detail})를 그대로 통과시키므로
  // (POST 핸들러가 !ok 응답을 apiSuccess로 감싸지 않고 원본 그대로 반환) 그 형태로 파싱한다.
  const handleCreateFolder = useCallback(
    async (name: string): Promise<{ ok: true } | { ok: false; errorMessage: string }> => {
      if (!projectId) return { ok: false, errorMessage: t('newFolderGenericError') };
      try {
        const res = await fetch('/api/folders', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, project_id: projectId }),
        });
        if (!res.ok) {
          if (res.status === 409) return { ok: false, errorMessage: t('newFolderDuplicateError') };
          return { ok: false, errorMessage: t('newFolderGenericError') };
        }
        const json = (await res.json()) as { data?: Folder };
        const created = json.data;
        if (!created) return { ok: false, errorMessage: t('newFolderGenericError') };
        setFolders((prev) => [...prev, created]);
        setSelectedFolderId(created.id);
        return { ok: true };
      } catch {
        return { ok: false, errorMessage: t('newFolderGenericError') };
      }
    },
    [projectId, t],
  );

  const buildAssetsUrl = useCallback(
    (cursor?: string | null) => {
      const p = new URLSearchParams();
      if (projectId) p.set('project_id', projectId);
      if (selectedFolderId) p.set('folder_id', selectedFolderId);
      if (effectiveSearch) p.set('q', effectiveSearch);
      p.set('sort', sort);
      p.set('order', order);
      if (cursor) p.set('cursor', cursor);
      return `/api/assets?${p.toString()}`;
    },
    [projectId, selectedFolderId, effectiveSearch, sort, order],
  );

  // 자산 fetch (필터 변경 시 리셋)
  useEffect(() => {
    if (!projectId) return;
    const reqId = (reqIdRef.current += 1);
    setLoading(true);
    setError(false);
    void (async () => {
      try {
        const res = await fetch(buildAssetsUrl());
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = (await res.json()) as { data?: AssetListResponse };
        if (reqIdRef.current !== reqId) return;
        setItems(json.data?.items ?? []);
        setNextCursor(json.data?.next_cursor ?? null);
      } catch {
        if (reqIdRef.current !== reqId) return;
        setError(true);
        setItems([]);
        setNextCursor(null);
      } finally {
        if (reqIdRef.current === reqId) setLoading(false);
      }
    })();
  }, [projectId, buildAssetsUrl]);

  const handleRetry = useCallback(() => {
    // buildAssetsUrl 의존성은 동일하므로 강제 재요청을 위해 effectiveSearch 토글 대신 재-set
    setError(false);
    setLoading(true);
    const reqId = (reqIdRef.current += 1);
    void (async () => {
      try {
        const res = await fetch(buildAssetsUrl());
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = (await res.json()) as { data?: AssetListResponse };
        if (reqIdRef.current !== reqId) return;
        setItems(json.data?.items ?? []);
        setNextCursor(json.data?.next_cursor ?? null);
      } catch {
        if (reqIdRef.current !== reqId) return;
        setError(true);
      } finally {
        if (reqIdRef.current === reqId) setLoading(false);
      }
    })();
  }, [buildAssetsUrl]);

  const handleLoadMore = useCallback(() => {
    if (!nextCursor || loadingMore) return;
    // 현 세대(필터/정렬/검색) 캡처 — 필터 변경·retry 시 reqIdRef 가 증가하므로 늦게 온 구 cursor 응답을 폐기.
    const reqId = reqIdRef.current;
    const cursor = nextCursor;
    setLoadingMore(true);
    void (async () => {
      try {
        const res = await fetch(buildAssetsUrl(cursor));
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = (await res.json()) as { data?: AssetListResponse };
        // 세대 검증: in-flight 중 필터/정렬/검색이 바뀌었으면 구 자산 append 금지(타폴더 혼입·중복·누락 방지).
        if (reqIdRef.current !== reqId) return;
        const incoming = json.data?.items ?? [];
        setItems((prev) => {
          const seen = new Set(prev.map((a) => a.id));
          const merged = prev.slice();
          for (const a of incoming) {
            if (!seen.has(a.id)) {
              seen.add(a.id);
              merged.push(a);
            }
          }
          return merged;
        });
        setNextCursor(json.data?.next_cursor ?? null);
      } catch {
        // load-more 실패 — 조용히 무시(기존 목록 유지)
      } finally {
        setLoadingMore(false);
      }
    })();
  }, [buildAssetsUrl, nextCursor, loadingMore]);

  const handleSortChange = useCallback((s: AssetSort) => {
    setSort(s);
    setOrder(s === 'name' ? 'asc' : 'desc');
  }, []);

  const handleSelectAsset = useCallback(
    (asset: Asset) => {
      setSelectedAssetId(asset.id);
      if (!detailPanel.supportsInlinePanel) detailPanel.setDrawerOpen(true);
    },
    [detailPanel],
  );

  const handleRequestDelete = useCallback((asset: Asset) => {
    setAssetToDelete(asset);
    setDeleteOpen(true);
  }, []);

  const handleDeleted = useCallback(
    (id: string) => {
      setItems((prev) => prev.filter((a) => a.id !== id));
      setSelectedAssetId((cur) => (cur === id ? null : cur));
    },
    [],
  );

  // 다운로드/업로드 = 어포던스 (S3/S7 미착지 → 컨트롤만 렌더, no-op)
  const noopAsset = useCallback((_asset: Asset) => {}, []);
  const noopUpload = useCallback(() => {}, []);

  const folderMap = useMemo(() => new Map(folders.map((f) => [f.id, f])), [folders]);
  const resolveFolderLabel = useCallback(
    (id: string | null): string | null => {
      if (!id) return null;
      const f = folderMap.get(id);
      if (!f) return null;
      const parts: string[] = [f.name];
      let cur = f.parent_id ? folderMap.get(f.parent_id) : undefined;
      let guard = 0;
      while (cur && guard < 4) {
        parts.unshift(cur.name);
        cur = cur.parent_id ? folderMap.get(cur.parent_id) : undefined;
        guard += 1;
      }
      return parts.join(' / ');
    },
    [folderMap],
  );

  const selectedAsset = useMemo(
    () => items.find((a) => a.id === selectedAssetId) ?? null,
    [items, selectedAssetId],
  );

  // 요약 칩: 로드된 집합 기준(전체 카운트 전용 엔드포인트 부재 — 가정/NOTE).
  const totalBytes = useMemo(() => items.reduce((sum, a) => sum + (a.size_bytes || 0), 0), [items]);

  const topBarTitle = useMemo(
    () => (
      <div className="flex min-w-0 items-center gap-2.5">
        <span className="shrink-0 text-[12px] text-muted-foreground">{t('breadcrumb')}</span>
        <span className="shrink-0 text-[12px] text-muted-foreground">/</span>
        <h1 className="shrink-0 text-[15px] font-[650] tracking-[-0.01em] text-foreground">{t('title')}</h1>
        <Badge variant="info" className="ml-1 shrink-0 font-bold">
          {t('summary', { count: items.length, size: formatTotalSize(totalBytes) })}
        </Badge>
      </div>
    ),
    [t, items.length, totalBytes],
  );

  const supportsInlinePanel = detailPanel.supportsInlinePanel;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <TopBarSlot title={topBarTitle} showContextChip />

      <div className="px-4 pt-3 empty:hidden">
        <StorageCapacityBanner />
      </div>

      <div
        className={cn(
          'grid min-h-0 flex-1',
          supportsInlinePanel
            ? 'grid-cols-[248px_minmax(0,1fr)_372px]'
            : 'grid-cols-[248px_minmax(0,1fr)]',
        )}
      >
        <StorageFolderTree
          folders={folders}
          selectedFolderId={selectedFolderId}
          onSelectFolder={setSelectedFolderId}
          projectId={projectId}
          projectName={projectName}
          folderSearch={folderSearch}
          onFolderSearchChange={setFolderSearch}
          onCreateFolder={handleCreateFolder}
        />

        <StorageAssetList
          assets={items}
          viewMode={viewMode}
          onViewModeChange={setViewMode}
          search={search}
          onSearchChange={setSearch}
          sort={sort}
          onSortChange={handleSortChange}
          selectedAssetId={selectedAssetId}
          onSelectAsset={handleSelectAsset}
          onDeleteAsset={handleRequestDelete}
          onDownloadAsset={noopAsset}
          onUpload={noopUpload}
          resolveFolderLabel={resolveFolderLabel}
          loading={loading}
          error={error}
          onRetry={handleRetry}
          isSearchActive={effectiveSearch.length > 0}
          hasMore={nextCursor != null}
          loadingMore={loadingMore}
          onLoadMore={handleLoadMore}
        />

        {supportsInlinePanel ? (
          <StorageDetailPanel
            asset={selectedAsset}
            folderLabel={resolveFolderLabel(selectedAsset?.folder_id ?? null)}
            onDownload={noopAsset}
            onRequestDelete={handleRequestDelete}
          />
        ) : null}
      </div>

      {/* <1536: 상세 패널 드로어 (contextual-panel storageKey 'storage-detail') */}
      {!supportsInlinePanel && detailPanel.drawerOpen ? (
        <div
          ref={detailDrawerTrapRef}
          tabIndex={-1}
          className="fixed inset-0 z-50 outline-none"
          role="dialog"
          aria-modal="true"
          aria-label={t('title')}
        >
          <button
            type="button"
            aria-label={t('cancel')}
            className="absolute inset-0 bg-black/55 backdrop-blur-[2px]"
            onClick={() => detailPanel.setDrawerOpen(false)}
          />
          <div className="absolute inset-y-0 right-0 w-[min(92vw,372px)]">
            <StorageDetailPanel
              asset={selectedAsset}
              folderLabel={resolveFolderLabel(selectedAsset?.folder_id ?? null)}
              onDownload={noopAsset}
              onRequestDelete={handleRequestDelete}
              onClose={() => detailPanel.setDrawerOpen(false)}
            />
          </div>
        </div>
      ) : null}

      <StorageDeleteDialog
        asset={assetToDelete}
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        onDeleted={handleDeleted}
      />
    </div>
  );
}
