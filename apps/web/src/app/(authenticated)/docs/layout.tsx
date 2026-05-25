'use client';

import { useCallback, useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { DocTree } from '@/components/docs/doc-tree';
import { RecentsSection } from '@/components/docs/recents-section';
import { useRecentDocs } from '@/components/docs/use-recent-docs';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { ToastContainer, useToast } from '@/components/ui/toast';
import { TopBarSlot } from '@/components/nav/top-bar-slot';
import { ChevronDown, ChevronLeft, ChevronRight, Menu, Plus, X } from 'lucide-react';
import { useDashboardContext } from '../../dashboard/dashboard-shell';
import { DocsLayoutContext, type Doc, type DocUpdate } from './docs-context';
import { useSwipeDrawer } from '@/lib/use-swipe-drawer';

export default function DocsLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const params = useParams();
  const currentSlug = typeof params.slug === 'string' ? params.slug : null;
  const t = useTranslations('docs');
  const tc = useTranslations('common');
  const { projectId } = useDashboardContext();
  const { recentSlugs, pushRecent } = useRecentDocs(projectId);
  const { toasts, addToast, dismissToast } = useToast();

  const [tree, setTree] = useState<Doc[]>([]);
  const [loading, setLoading] = useState(true);
  const [treeDrawerOpen, setTreeDrawerOpen] = useState(false);
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [docsHasMore, setDocsHasMore] = useState(false);
  const [docsNextCursor, setDocsNextCursor] = useState<string | null>(null);
  const [docsLoadingMore, setDocsLoadingMore] = useState(false);
  const [tagsCollapsed, setTagsCollapsed] = useState(true);

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
    router.push(`/docs/${slug}`);
    setTreeDrawerOpen(false);
  }, [router, pushRecent]);

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

  const handleMoveDenied = useCallback((reason: 'circular' | 'no-permission') => {
    if (reason === 'circular') addToast({ title: t('moveCircularError'), type: 'error' });
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
      setTree((prev) => [{ id: data.id, parent_id: data.parent_id || null, title: data.title, slug: data.slug, icon: data.icon || null, sort_order: data.sort_order || 0, is_folder: data.is_folder || false }, ...prev]);
      router.push(`/docs/${data.slug}?new=1`);
    } catch {
      addToast({ title: t('createFailed'), type: 'error' });
    } finally {
      setIsCreating(false);
    }
  }, [projectId, isCreating, router, addToast, t]);

  const handleNewDoc = useCallback(() => { void createDoc(null); }, [createDoc]);
  const handleAddChild = useCallback((parentId: string) => createDoc(parentId), [createDoc]);

  const openDrawer = useCallback(() => setTreeDrawerOpen(true), []);
  const closeDrawer = useCallback(() => setTreeDrawerOpen(false), []);
  const { progress: drawerProgress, dragging: drawerDragging } = useSwipeDrawer(treeDrawerOpen, openDrawer, closeDrawer);

  const sidebarContent = (
    <>
      {(() => {
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
        {loading ? (
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
            <DocTree docs={tree} selectedSlug={currentSlug} onSelect={handleSelectDoc} onReorder={handleReorder} onMove={handleMove} onMoveDenied={handleMoveDenied} onRename={handleRename} onDelete={handleDeleteDoc} onAddChild={handleAddChild} projectId={projectId} />
            {docsHasMore && (
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
    <DocsLayoutContext.Provider value={{ projectId, setTree, handleNewDoc, fetchTree, pendingDocUpdate, clearPendingDocUpdate }}>
      <TopBarSlot
        title={<h1 className="text-sm font-medium">{t('title')}</h1>}
        actions={<Button size="sm" variant="outline" onClick={handleNewDoc} disabled={isCreating}><Plus className="mr-1.5 h-3.5 w-3.5" />{isCreating ? t('loading') : t('newDoc')}</Button>}
      />

      {/* Desktop: 2-panel (lg+) */}
      <div className="hidden min-h-0 flex-1 overflow-hidden lg:flex">
        {!sidebarCollapsed && (
          <aside className="relative flex w-[300px] flex-shrink-0 flex-col overflow-y-auto border-r border-border/80 bg-background">
            <button
              type="button"
              onClick={handleToggleSidebar}
              title={t('hideSidebar')}
              className="absolute right-2 top-2 z-10 rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              <ChevronLeft className="size-4" />
            </button>
            {sidebarContent}
          </aside>
        )}
        <section className="relative flex min-w-0 flex-1 flex-col overflow-hidden bg-background">
          {sidebarCollapsed && (
            <button
              type="button"
              onClick={handleToggleSidebar}
              title={t('openSidebar')}
              className="absolute left-2 top-2 z-10 rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              <ChevronRight className="size-4" />
            </button>
          )}
          {children}
        </section>
      </div>

      {/* Mobile: content + tree drawer (< lg) */}
      <div className="flex flex-1 flex-col overflow-hidden lg:hidden">
        <div className="flex-shrink-0 flex items-center gap-2 border-b border-border/80 bg-background px-4 py-2">
          <button type="button" onClick={() => setTreeDrawerOpen(true)} className="flex min-h-[44px] items-center gap-2 text-sm text-muted-foreground hover:text-foreground" aria-label="문서 트리 열기">
            <Menu className="size-4" />
            <span>{t('title')}</span>
          </button>
        </div>
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-background">
          {children}
        </div>
        {/* Swipe drawer overlay */}
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
        {/* Swipe drawer panel */}
        <div
          className="fixed inset-y-0 left-0 z-50 flex w-[280px] flex-col overflow-hidden bg-background shadow-xl lg:hidden"
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
          <div className="flex-1 overflow-y-auto">{sidebarContent}</div>
        </div>
      </div>

      <ToastContainer toasts={toasts} onDismiss={dismissToast} />
    </DocsLayoutContext.Provider>
  );
}
