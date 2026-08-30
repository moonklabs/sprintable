'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { cn } from '@/lib/utils';
import { TopBarSlot } from '@/components/nav/top-bar-slot';
import { Badge } from '@/components/ui/badge';
import { ToastContainer, useToast } from '@/components/ui/toast';
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
import { fetchWithAuth } from '@/lib/db/client';

// story #2302 AC1 — `?asset=` 딥링크가 무엇을 해야 하는지의 판정만 순수 함수로 뽑아 둔다
// (StorageView 전체를 렌더하지 않고도 이 결정 로직 자체를 단위테스트하기 위함 — 이 컴포넌트는
// useDashboardContext/useContextualPanelState/useFocusTrap 등 컨텍스트가 많아 풀 렌더 테스트
// 비용이 크다). 부수효과(fetch·setState)는 호출부(useEffect)에 그대로 둔다.
export type AssetDeepLinkAction =
  | { type: 'none' }
  | { type: 'wait' }
  | { type: 'select-from-page'; assetId: string }
  | { type: 'fetch-fallback'; assetId: string };

export function resolveAssetDeepLinkAction(params: {
  assetId: string | null;
  projectId: string;
  selectedAssetId: string | null;
  items: Pick<Asset, 'id'>[];
  loading: boolean;
}): AssetDeepLinkAction {
  const { assetId, projectId, selectedAssetId, items, loading } = params;
  if (!assetId || !projectId) return { type: 'none' };
  if (selectedAssetId === assetId) return { type: 'none' }; // 이미 선택돼 있다 — 재실행 방지.
  if (items.some((a) => a.id === assetId)) return { type: 'select-from-page', assetId };
  // "첫 페이지에 있을 때만 되는" 반쪽 링크를 만들지 않기 위해(PO 판정 — epic 404와 같은 부류:
  // 갈 수 있다고 말하고 배신하는 것이 제일 나쁘다) 못 찾으면 무조건 포기하지 않고 단건조회로 폴백한다.
  if (loading) return { type: 'wait' }; // 첫 페이지 로드가 아직 안 끝났다 — 그 결과부터 보고 판단.
  return { type: 'fetch-fallback', assetId };
}

// story a539c649 S3a/b: projectId 는 이제 page.tsx(headers() 경유 resolve 결과)가 prop 으로
// 내려준다 — useDashboardContext()(전역 "현재 프로젝트")가 아니라 URL 이 가리키는 project.
// projectName 은 순수 표시용(폴더 트리 헤더)이라 전역 컨텍스트 그대로 유지(artifacts와 동형).
export function StorageView({ projectId }: { projectId: string }) {
  const t = useTranslations('storage');
  const { toasts, addToast, dismissToast } = useToast();
  const { projectName } = useDashboardContext();
  const searchParams = useSearchParams();

  const [folders, setFolders] = useState<Folder[]>([]);
  const [items, setItems] = useState<Asset[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [nextCursor, setNextCursor] = useState<string | null>(null);

  const [selectedFolderId, setSelectedFolderId] = useState<string | null>(null);
  const [selectedAssetId, setSelectedAssetId] = useState<string | null>(null);
  // story #2302 — `?asset=` 딥링크(embed-card getEntityHref('asset',...)·team-activity-view가
  // 만드는 링크)가 지금까지 사문(死文)이었다(searchParams를 읽는 코드가 아예 없었다). items는
  // 커서 페이지네이션이라 그 asset이 첫 페이지/현재 폴더에 없으면 `items.find`가 못 찾는데,
  // "첫 페이지에 있을 때만 되는 링크"는 그 자체로 반쪽 fix(PO 판정 — epic 404와 같은 "갈 수
  // 있다고 말하고 배신하는" 부류) — 그래서 fetch-by-id 폴백을 별도 state로 둔다(items에 억지로
  // 끼워 넣지 않는다 — 다른 폴더 소속일 수 있어 목록 필터 의미를 깨지 않기 위함).
  const [deepLinkedAsset, setDeepLinkedAsset] = useState<Asset | null>(null);
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
        const res = await fetchWithAuth(`/api/folders?project_id=${encodeURIComponent(projectId)}`);
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

  // story #2302 AC1(asset을 실제로 ①로 만든다) — `?asset=`이 가리키는 자산을 자동 선택한다.
  // 현재(필터된) 페이지에 있으면 그대로 선택, 없으면(다른 폴더·다음 페이지) 단건 GET으로
  // 폴백해서 가져온다 — "첫 페이지에 있을 때만 되는" 반쪽 링크를 만들지 않기 위해서다(PO 판정,
  // epic 404와 같은 부류: 갈 수 있다고 말하고 배신하는 것이 제일 나쁘다).
  useEffect(() => {
    const action = resolveAssetDeepLinkAction({
      assetId: searchParams.get('asset'), projectId, selectedAssetId, items, loading,
    });
    if (action.type === 'none' || action.type === 'wait') return;
    if (action.type === 'select-from-page') {
      setSelectedAssetId(action.assetId);
      if (!detailPanel.supportsInlinePanel) setDetailDrawerOpen(true);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetchWithAuth(`/api/assets/${action.assetId}`);
        if (!res.ok) return; // 조용히 무시 — 대상이 없으면 그냥 선택되지 않는다(별도 에러 UI는 이 스코프 밖).
        const json = (await res.json()) as { data?: Asset };
        if (cancelled || !json.data) return;
        setDeepLinkedAsset(json.data);
        setSelectedAssetId(json.data.id);
        if (!detailPanel.supportsInlinePanel) setDetailDrawerOpen(true);
      } catch {
        /* 조용히 무시 */
      }
    })();
    return () => { cancelled = true; };
  }, [searchParams, projectId, selectedAssetId, items, loading, detailPanel.supportsInlinePanel, setDetailDrawerOpen]);

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

  // 다운로드 = 실동작 (story #886d996f). 기존 sign 경로(/api/attachments/sign?asset_id) 재사용 —
  // BE가 asset_id로 container/object_path를 서버측 재도출·storage.signRead(SSOT, 자체 서명 0).
  // asset.id만 넘기고, 실패 경로는 무신호 금지(toast). disposition=attachment로 인라인 아닌 저장.
  const handleDownloadAsset = useCallback(
    async (asset: Asset) => {
      try {
        const res = await fetchWithAuth(
          `/api/attachments/sign?asset_id=${encodeURIComponent(asset.id)}&disposition=attachment`,
        );
        if (!res.ok) throw new Error(`sign failed: ${res.status}`);
        const { data } = (await res.json()) as { data?: { url?: string } };
        if (!data?.url) throw new Error('sign returned no url');
        const a = document.createElement('a');
        a.href = data.url;
        a.rel = 'noopener';
        a.download = asset.name;
        document.body.appendChild(a);
        a.click();
        a.remove();
      } catch {
        addToast({ title: t('downloadErrorTitle'), body: t('downloadErrorDesc'), type: 'error' });
      }
    },
    [addToast, t],
  );

  // 업로드 = BE 선행 대기 (story #d4b371be: POST /assets/upload-url + /upload-confirm 착지 전까지
  // 배선 불가). 착지 후 이 no-op을 실 업로드(hidden file input→프리사인드 PUT→confirm)로 대체한다.
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
    () => items.find((a) => a.id === selectedAssetId)
      ?? (deepLinkedAsset?.id === selectedAssetId ? deepLinkedAsset : null),
    [items, selectedAssetId, deepLinkedAsset],
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
          onDownloadAsset={handleDownloadAsset}
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
            onDownload={handleDownloadAsset}
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
              onDownload={handleDownloadAsset}
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

      <ToastContainer toasts={toasts} onDismiss={dismissToast} />
    </div>
  );
}
