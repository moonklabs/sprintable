'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { cn } from '@/lib/utils';
import { useTopBar } from '@/components/nav/top-bar-context';
import { useMediaQuery } from '@/lib/use-media-query';
import { useHideOnScroll } from '@/lib/use-hide-on-scroll';
import { useParams, useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { DocTree } from '@/components/docs/doc-tree';
import { DocAutoGroups } from '@/components/docs/doc-auto-groups';
import { RecentsSection } from '@/components/docs/recents-section';
import { useRecentDocs } from '@/components/docs/use-recent-docs';
import { TreeSearchInput } from '@/components/docs/tree-search-input';
import { DocSearchResults, type DocSearchResult } from '@/components/docs/doc-search-results';
import { useTreeExpanded } from '@/components/docs/use-tree-expanded';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { ToastContainer, useToast } from '@/components/ui/toast';
import { TopBarSlot } from '@/components/nav/top-bar-slot';
import { ChevronDown, ChevronLeft, ChevronRight, FileText, Plus, X } from 'lucide-react';
import { DocsLayoutContext, type Doc, type DocSortMode, type DocUpdate } from './docs-context';
import { useSwipeDrawer } from '@/lib/use-swipe-drawer';
import { useFocusTrap } from '@/hooks/use-focus-trap';
import { newDocUrl, docUrl } from '@/components/docs/lib/doc-project-url';

// story #2167: BE search_full_text 의 limit(doc.py:83)과 동일 값 — 화면에 "상위 N건" 문구를
// 낼 때 실제 서버 cap과 어긋나지 않게 한 곳에서만 선언한다.
const DOC_SEARCH_LIMIT = 50;
// story #2167: 타이핑 매 keystroke마다 서버를 안 치도록 최소 지연(ms).
const DOC_SEARCH_DEBOUNCE_MS = 250;

interface DocsClientLayoutProps {
  children: React.ReactNode;
  wsSlug: string;
  projSlug: string;
  projectId: string;
}

// story a539c649 S2: projectId/wsSlug/projSlug 는 이제 서버 layout(headers() 경유 resolve 결과)
// 이 prop 으로 내려준다 — useDashboardContext()(전역 "현재 프로젝트")가 아니라 **이 URL 이
// 가리키는 project** 를 써야 #2154 클래스가 재발하지 않는다(자세한 배경은 layout.tsx 참고).
export function DocsClientLayout({ children, wsSlug, projSlug, projectId }: DocsClientLayoutProps) {
  const router = useRouter();
  const params = useParams();
  const currentSlug = typeof params.slug === 'string' ? params.slug : null;
  const t = useTranslations('docs');
  const tc = useTranslations('common');
  const { recentSlugs, pushRecent } = useRecentDocs(projectId);
  const { expandFolder } = useTreeExpanded(projectId);
  const { toasts, addToast, dismissToast } = useToast();

  const { scrollContainer, setHidden } = useTopBar();
  const isMobile = useMediaQuery('(max-width: 1023px)');
  const gnbHidden = useHideOnScroll({ enabled: isMobile, scrollContainer });

  useEffect(() => {
    setHidden(gnbHidden);
    return () => setHidden(false);
  }, [gnbHidden, setHidden]);

  const [tree, setTree] = useState<Doc[]>([]);
  const [loading, setLoading] = useState(true);
  const [treeDrawerOpen, setTreeDrawerOpen] = useState(false);
  // 모바일 트리거 칩 breadcrumb: 현재 문서명(flat tree에서 slug 조회·미선택 시 폴백).
  const currentDocTitle = currentSlug ? (tree.find((d) => d.slug === currentSlug)?.title ?? null) : null;
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [docsHasMore, setDocsHasMore] = useState(false);
  const [docsNextCursor, setDocsNextCursor] = useState<string | null>(null);
  const [docsLoadingMore, setDocsLoadingMore] = useState(false);
  const [tagsCollapsed, setTagsCollapsed] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const isSearching = searchQuery.trim().length > 0;
  const [searchResults, setSearchResults] = useState<DocSearchResult[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);

  // story #2167(2026-07-25, 까심, PO 판정 (나)): 검색어가 있을 때 "이 문서가 있는가"의 답은
  // 서버 전문검색(search_vector — slug 포함, migration 0206)만이 낸다. 로컬 트리(tree state)는
  // 페이지네이션된 사본이라 아직 안 로드된 문서는 로컬필터로 걸러도 못 찾는다 — 그 반쪽짜리
  // 상태를 피하려고 검색-모드는 전량 서버 결과로 갈아끼운다(DocSearchResults, 플랫 리스트).
  // 디바운스: 매 keystroke 요청 방지. AbortController: 늦게 도착한 stale 응답이 최신 타이핑
  // 결과를 덮어쓰는 레이스 방지.
  useEffect(() => {
    const q = searchQuery.trim();
    if (!q || !projectId) { setSearchResults([]); setSearchLoading(false); return; }

    setSearchLoading(true);
    const controller = new AbortController();
    const timer = setTimeout(() => {
      void fetch(`/api/docs?project_id=${encodeURIComponent(projectId)}&q=${encodeURIComponent(q)}&limit=${DOC_SEARCH_LIMIT}`, { signal: controller.signal })
        .then((res) => (res.ok ? res.json() : { data: [] }))
        .then((json: { data?: DocSearchResult[] }) => {
          setSearchResults(json.data ?? []);
          setSearchLoading(false);
        })
        .catch((err) => {
          if (err?.name === 'AbortError') return;
          setSearchResults([]);
          setSearchLoading(false);
        });
    }, DOC_SEARCH_DEBOUNCE_MS);

    return () => { clearTimeout(timer); controller.abort(); };
  }, [searchQuery, projectId]);

  // story #2167: 트리 표시 정렬 — 'manual'(sort_order·드래그로 바뀜, 기본값) / 'title' / 'updated_at'.
  // 프로젝트별 저장(기존 docs-sidebar-collapsed·use-tree-expanded와 동일 localStorage 패턴).
  // 표시 전용 — sort_order 값 자체는 이 토글로 절대 바뀌지 않는다(doc-tree.tsx compareDocsForSort
  // 참고). 'manual'로 돌아오면 드래그로 정한 순서가 그대로 남아있다.
  const [sortMode, setSortModeState] = useState<DocSortMode>('manual');
  useEffect(() => {
    if (!projectId) return;
    const saved = localStorage.getItem(`docs-sort-mode:${projectId}`);
    if (saved === 'manual' || saved === 'title' || saved === 'updated_at') setSortModeState(saved);
    else setSortModeState('manual');
  }, [projectId]);
  const setSortMode = useCallback((mode: DocSortMode) => {
    setSortModeState(mode);
    if (projectId) localStorage.setItem(`docs-sort-mode:${projectId}`, mode);
  }, [projectId]);

  // story #2193 — "자동 묶음"(slug 접두어로 그룹, 폴더 소속과 무관) / "내 폴더"(기존 DocTree,
  // 변경 없음) 전환. 기본값을 반드시 grouped로 둔다 — "내 폴더"를 기본으로 두면 폴더에 실제
  // 담긴 13%(80/619)만 먼저 보여주고 나머지 87%는 한 번 더 탭을 눌러야 보이는 것이 되어,
  // 이 스토리가 없애려는 문제(폴더 담김 여부에 발견 가능성이 좌우되는 것) 자체를 탭 순서로
  // 재현하게 된다. 폴더는 그대로 남아 원하는 사람은 "내 폴더"로 전환해 쓴다.
  const [viewMode, setViewModeState] = useState<'grouped' | 'folders'>('grouped');
  useEffect(() => {
    if (!projectId) return;
    const saved = localStorage.getItem(`docs-view-mode:${projectId}`);
    if (saved === 'grouped' || saved === 'folders') setViewModeState(saved);
  }, [projectId]);
  const setViewMode = useCallback((mode: 'grouped' | 'folders') => {
    setViewModeState(mode);
    if (projectId) localStorage.setItem(`docs-view-mode:${projectId}`, mode);
  }, [projectId]);

  const [pendingDocUpdate, setPendingDocUpdate] = useState<DocUpdate | null>(null);
  const clearPendingDocUpdate = useCallback(() => setPendingDocUpdate(null), []);

  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    if (typeof window === 'undefined') return false;
    return localStorage.getItem('docs-sidebar-collapsed') === 'true';
  });

  const handleToggleSidebar = useCallback(() => {
    setSidebarCollapsed((prev) => {
      const next = !prev;
      localStorage.setItem('docs-sidebar-collapsed', String(next));
      return next;
    });
  }, []);

  const [isCreating, setIsCreating] = useState(false);

  const fetchTree = useCallback(async (tags?: string[], cursor?: string | null) => {
    if (!projectId) return;
    try {
      const fetchParams = new URLSearchParams({ project_id: projectId, limit: '20' });
      if (tags?.length) fetchParams.set('tags', tags.join(','));
      else fetchParams.set('view', 'tree');
      if (cursor) fetchParams.set('cursor', cursor);
      const res = await fetch(`/api/docs?${fetchParams.toString()}`);
      if (!res.ok) throw new Error('Failed to fetch tree');
      const { data, meta } = await res.json() as { data: Doc[]; meta?: { hasMore?: boolean; nextCursor?: string | null } };
      if (cursor) {
        setTree((prev) => [...prev, ...(data || [])]);
      } else {
        setTree(data || []);
      }
      setDocsHasMore(meta?.hasMore ?? false);
      setDocsNextCursor(meta?.nextCursor ?? null);
    } catch {
      // tree fetch failed — keep existing
    } finally {
      setLoading(false);
      setDocsLoadingMore(false);
    }
  }, [projectId]);

  useEffect(() => { void fetchTree(selectedTags.length ? selectedTags : undefined); }, [fetchTree, selectedTags]);

  const handleSelectDoc = useCallback((slug: string) => {
    pushRecent(slug);
    // story a539c649 S2: wsSlug/projSlug 는 layout.tsx 가 항상 보장(notFound() 미보장 시 차단)
    // — #2154 폴백 분기 자체가 불필요해졌다(구조적 소거).
    router.push(docUrl(wsSlug, projSlug, slug));
    setTreeDrawerOpen(false);
  }, [router, pushRecent, wsSlug, projSlug]);

  const handleReorder = useCallback(async (docId: string, newSortOrder: number) => {
    setTree((prev) => prev.map((doc) => (doc.id === docId ? { ...doc, sort_order: newSortOrder } : doc)));
    try {
      const res = await fetch(`/api/docs/${docId}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sort_order: newSortOrder }) });
      if (!res.ok) await fetchTree();
    } catch { await fetchTree(); }
  }, [fetchTree]);

  const handleMove = useCallback(async (docId: string, newParent: string | null, newSortOrder: number) => {
    setTree((prev) => prev.map((doc) => (doc.id === docId ? { ...doc, parent_id: newParent, sort_order: newSortOrder } : doc)));
    try {
      const res = await fetch(`/api/docs/${docId}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ parent_id: newParent, sort_order: newSortOrder }) });
      if (!res.ok) await fetchTree();
    } catch { await fetchTree(); }
  }, [fetchTree]);

  const handleMoveDenied = useCallback((reason: 'circular' | 'no-permission' | 'sort-mode-active') => {
    if (reason === 'circular') addToast({ title: t('moveCircularError'), type: 'error' });
    else if (reason === 'sort-mode-active') addToast({ title: t('moveSortModeActiveError'), type: 'warning' });
    else addToast({ title: t('movePermissionError'), type: 'warning' });
  }, [addToast, t]);

  const handleRename = useCallback(async (docId: string, newName: string) => {
    setTree((prev) => prev.map((doc) => (doc.id === docId ? { ...doc, title: newName } : doc)));
    try {
      const res = await fetch(`/api/docs/${docId}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: newName }) });
      if (!res.ok) {
        await fetchTree();
      } else {
        const { data } = await res.json() as { data: { updated_at: string } };
        setPendingDocUpdate({ id: docId, title: newName, updated_at: data.updated_at });
      }
    } catch { await fetchTree(); }
  }, [fetchTree]);

  const handleDeleteDoc = useCallback(async (docId: string) => {
    setTree((prev) => prev.filter((doc) => doc.id !== docId));
    try {
      const res = await fetch(`/api/docs/${docId}`, { method: 'DELETE' });
      if (!res.ok) await fetchTree();
    } catch { await fetchTree(); }
  }, [fetchTree]);

  const createDoc = useCallback(async (parentId: string | null = null) => {
    if (!projectId || isCreating) return;
    setIsCreating(true);
    const slug = `untitled-${Date.now()}`;
    try {
      const res = await fetch('/api/docs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project_id: projectId, title: 'Untitled', slug, content: '', content_format: 'markdown', parent_id: parentId }),
      });
      if (!res.ok) throw new Error('Failed to create doc');
      const { data } = await res.json();
      setTree((prev) => [{ id: data.id, parent_id: data.parent_id || null, title: data.title, slug: data.slug, icon: data.icon || null, sort_order: data.sort_order || 0, is_folder: data.is_folder || false, updated_at: data.updated_at }, ...prev]);
      // story a539c649 S2 — doc-project-url.ts 헤더 참고(#2154 구조적 소거).
      router.push(newDocUrl(wsSlug, projSlug, data.slug));
    } catch {
      addToast({ title: t('createFailed'), type: 'error' });
    } finally {
      setIsCreating(false);
    }
  }, [projectId, isCreating, router, addToast, t, wsSlug, projSlug]);

  const handleNewDoc = useCallback(() => { void createDoc(null); }, [createDoc]);
  const handleAddChild = useCallback((parentId: string) => createDoc(parentId), [createDoc]);

  const openDrawer = useCallback(() => setTreeDrawerOpen(true), []);
  const closeDrawer = useCallback(() => setTreeDrawerOpen(false), []);
  const { progress: drawerProgress, dragging: drawerDragging } = useSwipeDrawer(treeDrawerOpen, openDrawer, closeDrawer);
  // story #2061 — 처음엔 제스처 물리(drawerProgress/drawerDragging) 때문에 Dialog 전면교체가
  // hard라 판단했으나, 트랩만 별도로 붙이는 건 제스처와 무관하다(터치 드래그 중엔 treeDrawerOpen
  // 자체가 안 바뀌고 release 시점에만 커밋되므로 — useSwipeDrawer 참고). Tab 트랩+Esc+반환만.
  const drawerTrapRef = useFocusTrap(treeDrawerOpen, closeDrawer);

  const topBarTitle = useMemo(
    () => <h1 className="text-sm font-medium">{t('title')}</h1>,
    [t]
  );
  const topBarActions = useMemo(
    () => (
      <Button size="sm" variant="outline" onClick={handleNewDoc} disabled={isCreating}>
        <Plus className="mr-1.5 h-3.5 w-3.5" />
        {isCreating ? t('loading') : t('newDoc')}
      </Button>
    ),
    [handleNewDoc, isCreating, t]
  );

  const sidebarContent = (
    <>
      <TreeSearchInput
        value={searchQuery}
        onChange={setSearchQuery}
        onClear={() => setSearchQuery('')}
        isSearching={isSearching}
        matchCount={searchResults.length}
        placeholder={t('searchTree')}
        clearLabel={t('clearSearch')}
        noResultsLabel={t('searchNoResults')}
        resultCountLabel={(n) => t('searchResultCount', { count: n })}
      />
      {/* story #2193 — "자동 묶음"(slug 접두어) / "내 폴더"(기존 트리) 전환. 검색 중엔
          숨긴다(서버 전문검색 결과가 이미 답이라 그룹/트리 뷰 자체가 무의미 — sortMode
          토글과 동일한 판단). */}
      {!isSearching && (
        <div className="flex border-b border-border/60 px-2 pt-1.5">
          {(['grouped', 'folders'] as const).map((mode) => (
            <button
              key={mode}
              type="button"
              onClick={() => setViewMode(mode)}
              className={cn(
                'flex-1 border-b-2 px-2 pb-1.5 text-[11px] font-medium transition-colors',
                viewMode === mode
                  ? 'border-primary text-foreground'
                  : 'border-transparent text-muted-foreground hover:text-foreground',
              )}
            >
              {mode === 'grouped' ? t('viewModeGrouped') : t('viewModeFolders')}
            </button>
          ))}
        </div>
      )}
      {/* story #2167: 검색어 없을 때만 노출 — 검색 결과(서버 전문검색)는 ts_rank 관련도순이라
          사용자가 고를 정렬 축이 아니다. 정렬은 "브라우징 중인 트리"에만 의미가 있다.
          #2193: 정렬 토글은 "내 폴더"(기존 트리) 뷰에서만 의미가 있다 — 자동 묶음 뷰는
          그룹 크기 기준 자체 정렬을 쓴다. */}
      {!isSearching && viewMode === 'folders' && (
        <div className="flex items-center gap-1.5 border-b border-border/60 px-3 py-1.5">
          <label htmlFor="docs-sort-mode" className="text-[11px] text-muted-foreground">{t('sortModeLabel')}</label>
          <select
            id="docs-sort-mode"
            value={sortMode}
            onChange={(e) => setSortMode(e.target.value as DocSortMode)}
            className="rounded-md border border-border bg-background px-1.5 py-0.5 text-[11px] text-foreground"
          >
            <option value="manual">{t('sortModeManual')}</option>
            <option value="title">{t('sortModeTitle')}</option>
            <option value="updated_at">{t('sortModeUpdatedAt')}</option>
          </select>
        </div>
      )}
      {!isSearching && (() => {
        const allTags = [...new Set(tree.flatMap((d) => (d as unknown as { tags?: string[] | null }).tags ?? []))];
        if (allTags.length === 0) return null;
        return (
          <div className="border-b border-border">
            <button type="button" onClick={() => setTagsCollapsed((v) => !v)} className="flex w-full items-center justify-between px-4 py-1 text-[11px] text-muted-foreground hover:text-foreground">
              <span className="flex items-center gap-1.5">
                {tagsCollapsed ? <ChevronRight className="size-3" /> : <ChevronDown className="size-3" />}
                {t('tagFilter')}
                {tagsCollapsed && selectedTags.length > 0 && (
                  <span className="rounded-full bg-primary px-1.5 py-0.5 text-[10px] font-semibold text-primary-foreground">{selectedTags.length}</span>
                )}
              </span>
            </button>
            {!tagsCollapsed && (
              <div className="flex max-h-[120px] flex-wrap gap-1 overflow-y-auto px-4 py-1">
                {allTags.map((tag) => (
                  <button key={tag} type="button" onClick={() => setSelectedTags((prev) => prev.includes(tag) ? prev.filter((tg) => tg !== tag) : [...prev, tag])} className={`rounded-full px-2 py-0.5 text-[11px] font-medium transition ${selectedTags.includes(tag) ? 'bg-primary text-primary-foreground' : 'bg-muted/60 text-muted-foreground hover:bg-muted'}`}>
                    #{tag}
                  </button>
                ))}
                {selectedTags.length > 0 && <button type="button" onClick={() => setSelectedTags([])} className="text-[11px] text-muted-foreground underline hover:text-foreground">{t('clearFilter')}</button>}
              </div>
            )}
          </div>
        );
      })()}
      <div className="flex-1 overflow-y-auto p-2">
        {isSearching ? (
          <DocSearchResults
            results={searchResults}
            loading={searchLoading}
            selectedSlug={currentSlug}
            onSelect={handleSelectDoc}
            loadingLabel={t('searchLoading')}
            noResultsLabel={t('searchNoResults')}
            resultCountLabel={(n) => t('searchResultCount', { count: n })}
            cappedLabel={t('searchResultsCapped', { count: DOC_SEARCH_LIMIT })}
            cap={DOC_SEARCH_LIMIT}
          />
        ) : loading ? (
          <p className="px-2 py-4 text-xs text-muted-foreground">{t('loading')}</p>
        ) : tree.length === 0 ? (
          <EmptyState title={t('title')} description={t('selectDoc')} className="mt-2 bg-background/70" action={<Button size="sm" onClick={handleNewDoc}><Plus className="mr-1 h-4 w-4" />{t('newDoc')}</Button>} />
        ) : (
          <>
            <RecentsSection
              recentSlugs={recentSlugs}
              docs={tree}
              selectedSlug={currentSlug}
              onSelect={handleSelectDoc}
              label={t('recentDocs')}
              emptyLabel={t('noRecentDocs')}
            />
            {viewMode === 'grouped' ? (
              <DocAutoGroups
                docs={tree}
                selectedSlug={currentSlug}
                onSelect={handleSelectDoc}
                inFolderLabel={t('groupInFolder')}
                looseAtRootLabel={t('groupLooseAtRoot')}
                thisMonthLabel={t('groupThisMonth')}
                lastMonthLabel={t('groupLastMonth')}
                olderLabel={t('groupOlder')}
                unknownDateLabel={t('groupUnknownDate')}
                moreLabel={(count) => t('groupMore', { count })}
              />
            ) : (
              <DocTree docs={tree} selectedSlug={currentSlug} onSelect={handleSelectDoc} onReorder={handleReorder} onMove={handleMove} onMoveDenied={handleMoveDenied} onRename={handleRename} onDelete={handleDeleteDoc} onAddChild={handleAddChild} projectId={projectId} sortMode={sortMode} />
            )}
            {viewMode === 'folders' && docsHasMore && (
              <div className="px-2 py-1">
                <Button variant="ghost" size="sm" className="w-full text-xs text-muted-foreground" disabled={docsLoadingMore} onClick={() => { if (!docsNextCursor || docsLoadingMore) return; setDocsLoadingMore(true); void fetchTree(selectedTags.length ? selectedTags : undefined, docsNextCursor); }}>
                  {docsLoadingMore ? tc('loading') : tc('loadMore')}
                </Button>
              </div>
            )}
          </>
        )}
      </div>
    </>
  );


  return (
    <DocsLayoutContext.Provider value={{ wsSlug, projSlug, projectId, tree, setTree, handleNewDoc, fetchTree, pendingDocUpdate, clearPendingDocUpdate, expandFolder, openTreeDrawer: openDrawer }}>
      {/* 근본 재구현(2076 회귀 후속, 유나양 규격) — currentSlug 없음(목록)=켬, 있음(문서 하나)=
          끔. 이 shell은 단일 문서가 화면을 꽉 채우는 구조(목록+본문 동시 2단 아님)라 이 분기가
          맞다(2단 shell이었다면 항상 켜야 함 — 유나양 규격 예외 조항). */}
      <TopBarSlot
        title={topBarTitle}
        actions={topBarActions}
        showContextChip={!currentSlug}
      />

      {/* Unified: children rendered exactly once — sidebar responsive via breakpoint classes */}
      <div className="flex min-h-0 flex-1 overflow-hidden">
        {/* Desktop sidebar — hidden on mobile */}
        {!sidebarCollapsed && (
          <aside className="focus-inset relative hidden w-[236px] flex-shrink-0 flex-col overflow-y-auto border-r border-border/80 bg-background lg:flex">
            <button
              type="button"
              onClick={handleToggleSidebar}
              title={t('hideSidebar')}
              className="absolute right-2 top-2 z-10 rounded-md border border-border p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              <ChevronLeft className="size-4" />
            </button>
            {sidebarContent}
          </aside>
        )}
        <section className="relative flex min-w-0 flex-1 flex-col overflow-hidden bg-background">
          {/* 박스1: 모바일 칩 띠는 리스트뷰(문서 미선택)서만 노출 — doc 상세는 슬림 헤더 트리 아이콘이
              트리 트리거 대체(중복 빈 띠 제거·문서명은 헤더 제목이 흡수). 리스트뷰는 칩이 유일 트리 접근이라 보존. */}
          {!currentSlug && (
          <div
            className={cn(
              'flex-shrink-0 flex items-center gap-2 border-b border-border/80 bg-background px-4 py-2 lg:hidden',
              'sticky top-12 z-20 transition-transform',
              '[transition-duration:var(--gnb-hide-duration)]',
              '[transition-timing-function:var(--gnb-hide-easing)]',
              gnbHidden && '-translate-y-[calc(100%+var(--gnb-mobile-height))]',
            )}
          >
            <button type="button" onClick={() => setTreeDrawerOpen(true)} className="flex min-h-[44px] min-w-0 max-w-full items-center gap-2 rounded-lg border border-border px-3 text-sm text-foreground transition-colors hover:bg-accent" aria-label="문서 트리 열기">
              <FileText className="size-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 truncate font-medium">{currentDocTitle ?? t('title')}</span>
              <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
            </button>
          </div>
          )}
          {/* Desktop collapsed sidebar open button */}
          {sidebarCollapsed && (
            <button
              type="button"
              onClick={handleToggleSidebar}
              title={t('openSidebar')}
              className="absolute left-2 top-2 z-10 hidden rounded-md border border-border p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground lg:block"
            >
              <ChevronRight className="size-4" />
            </button>
          )}
          {children}
        </section>
        {/* Mobile swipe drawer overlay */}
        <div
          className="fixed inset-0 z-40 bg-foreground/40 lg:hidden"
          style={{
            opacity: drawerProgress,
            pointerEvents: drawerProgress > 0.05 ? 'auto' : 'none',
            transition: drawerDragging ? 'none' : 'opacity 280ms cubic-bezier(0.4,0,0.2,1)',
          }}
          onClick={closeDrawer}
          aria-hidden="true"
        />
        {/* Mobile swipe drawer panel */}
        <div
          ref={drawerTrapRef}
          tabIndex={-1}
          role="dialog"
          aria-modal="true"
          aria-label={t('title')}
          className="fixed inset-y-0 left-0 z-50 flex w-[280px] flex-col overflow-hidden border-r border-border bg-background shadow-lg outline-none lg:hidden"
          style={{
            transform: `translateX(${(drawerProgress - 1) * 100}%)`,
            transition: drawerDragging ? 'none' : 'transform 280ms cubic-bezier(0.4,0,0.2,1)',
          }}
          aria-hidden={drawerProgress === 0}
        >
          <div className="flex flex-shrink-0 items-center justify-between border-b border-border/80 px-4 py-3">
            <span className="text-sm font-medium text-foreground">{t('title')}</span>
            <button type="button" onClick={closeDrawer} className="rounded p-1 text-muted-foreground hover:text-foreground" aria-label="닫기"><X className="size-4" /></button>
          </div>
          <div className="focus-inset flex-1 overflow-y-auto">{sidebarContent}</div>
        </div>
      </div>

      <ToastContainer toasts={toasts} onDismiss={dismissToast} />
    </DocsLayoutContext.Provider>
  );
}
