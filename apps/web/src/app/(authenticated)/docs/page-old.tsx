'use client';

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { ChevronDown, Menu, Plus, X } from 'lucide-react';
import { useDashboardContext } from '../../dashboard/dashboard-shell';
import { UpgradeModal } from '@/components/ui/upgrade-modal';
import { DocTree } from '@/components/docs/doc-tree';
import { PolicyDocBrowser } from '@/components/docs/policy-doc-browser';
import { DocEditor } from '@/components/docs/doc-editor';
import { DocContentRenderer } from '@/components/docs/doc-content-renderer';
import { extractDocHeadings } from '@/components/docs/doc-heading-utils';
import { getRestoredRevisionDraft, getRevisionContentFormat } from '@/components/docs/doc-revision-utils';
import { useDocSync, type SaveStatus } from '@/components/docs/use-doc-sync';
import { GlassPanel } from '@/components/ui/glass-panel';
import { EmptyState } from '@/components/ui/empty-state';
import { PageHeader } from '@/components/ui/page-header';
import { Button } from '@/components/ui/button';
import { ContextualPanelLayout, useContextualPanelState } from '@/components/ui/contextual-panel-layout';
import { SectionCard, SectionCardBody, SectionCardHeader } from '@/components/ui/section-card';

interface Doc { id: string; parent_id: string | null; title: string; slug: string; icon: string | null; sort_order: number; is_folder?: boolean }
interface DocDetail { id: string; title: string; slug: string; content: string; content_format?: 'markdown' | 'html'; updated_at: string; parent_id?: string | null; icon?: string | null; tags?: string[] | null; sort_order?: number; is_folder?: boolean }
interface Comment { id: string; content: string; created_at: string; created_by: string }
interface Revision { id: string; content: string; content_format?: 'markdown' | 'html' | null; created_at: string; created_by: string }
interface SourceMemo { id: string; title: string | null; content: string; status: string; created_at: string; created_by: string }

const DOC_SLUG_PARAM = 'slug';
const DOC_COMMENT_PARAM = 'commentId';

function parseTagsInput(input: string): string[] {
  return Array.from(new Set(
    input
      .split(',')
      .map((token) => token.trim())
      .filter(Boolean),
  ));
}

export default function DocsPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const t = useTranslations('docs');
  const shellT = useTranslations('shell');
  const { projectId } = useDashboardContext();
  const [tree, setTree] = useState<Doc[]>([]);
  const [selectedDoc, setSelectedDoc] = useState<DocDetail | null>(null);
  const [comments, setComments] = useState<Comment[]>([]);
  const [revisions, setRevisions] = useState<Revision[]>([]);
  const [sourceMemos, setSourceMemos] = useState<SourceMemo[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<Doc[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editContent, setEditContent] = useState('');
  const [editContentFormat, setEditContentFormat] = useState<'markdown' | 'html'>('markdown');
  const [editIcon, setEditIcon] = useState('');
  const [editTagsInput, setEditTagsInput] = useState('');
  const [editorMode, setEditorMode] = useState<'write' | 'preview'>('write');
  const [showCreate, setShowCreate] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [newSlug, setNewSlug] = useState('');
  const [newIsFolder, setNewIsFolder] = useState(false);
  const [upgradeMessage, setUpgradeMessage] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<'docs' | 'policy'>('docs');
  const [serverUpdatedAt, setServerUpdatedAt] = useState<string | null>(null);
  const docsPanelStorageKey = useMemo(() => `docs:tree-panel:${projectId ?? 'no-project'}`, [projectId]);
  const docsPanel = useContextualPanelState({ storageKey: docsPanelStorageKey, defaultOpen: true });
  const {
    supportsInlinePanel: docsPanelSupportsInline,
    inlinePanelOpen: docsPanelInlineOpen,
    drawerOpen: docsPanelDrawerOpen,
    setDrawerOpen: setDocsPanelDrawerOpen,
    openPanel: openDocsPanel,
    closeDrawer: closeDocsPanelDrawer,
    togglePanel: toggleDocsPanel,
  } = docsPanel;
  const autoOpenedDocsPanelRef = useRef(false);
  const [previewRevisionId, setPreviewRevisionId] = useState<string | null>(null);
  const [activeHeadingId, setActiveHeadingId] = useState<string | null>(null);

  const contentContainerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    autoOpenedDocsPanelRef.current = false;
  }, [projectId]);

  const selectedDocSlug = searchParams.get(DOC_SLUG_PARAM);
  const selectedCommentId = searchParams.get(DOC_COMMENT_PARAM);

  const replaceDocSearchParams = useCallback((slug?: string | null, commentId?: string | null) => {
    const next = new URLSearchParams(searchParams.toString());

    if (slug) next.set(DOC_SLUG_PARAM, slug);
    else next.delete(DOC_SLUG_PARAM);

    if (commentId) next.set(DOC_COMMENT_PARAM, commentId);
    else next.delete(DOC_COMMENT_PARAM);

    const query = next.toString();
    router.replace(query ? `/docs?${query}` : '/docs', { scroll: false });
  }, [router, searchParams]);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      if (!projectId) {
        if (!cancelled) {
          setTree([]);
          setSelectedDoc(null);
          setComments([]);
          setRevisions([]);
          setSourceMemos([]);
          setSearchResults([]);
          setLoading(false);
        }
        return;
      }
      setLoading(true);
      try {
        const res = await fetch(`/api/docs?project_id=${projectId}&view=tree`);
        if (res.ok && !cancelled) {
          const json = await res.json();
          setTree(json.data);
          setNextCursor(null);
        }
      } catch {
        // noop
      }
      if (!cancelled) setLoading(false);
    }

    void load();
    return () => { cancelled = true; };
  }, [projectId]);

  const applyLoadedDoc = useCallback((doc: DocDetail, options?: { preserveEditing?: boolean; preserveEditorMode?: boolean }) => {
    setSelectedDoc(doc);
    setEditContent(doc.content ?? '');
    setEditContentFormat(doc.content_format ?? 'markdown');
    setEditIcon(doc.icon ?? '');
    setEditTagsInput((doc.tags ?? []).join(', '));
    setServerUpdatedAt(doc.updated_at);
    setPreviewRevisionId(null);
    setActiveHeadingId(null);

    if (!options?.preserveEditorMode) {
      setEditorMode('write');
    }

    if (!options?.preserveEditing) {
      setEditing(false);
    }
  }, []);

  const loadDocExtras = useCallback(async (doc: DocDetail) => {
    const [commentsRes, revisionsRes] = await Promise.all([
      fetch(`/api/docs/${doc.id}/comments`),
      fetch(`/api/docs/${doc.id}/revisions`),
    ]);

    if (commentsRes.ok) setComments((await commentsRes.json()).data ?? []);
    if (revisionsRes.ok) setRevisions((await revisionsRes.json()).data ?? []);

    const sourceMemosRes = await fetch(`/api/memos?project_id=${projectId}&limit=30&q=${encodeURIComponent(doc.title)}`);
    if (sourceMemosRes.ok) {
      const json = await sourceMemosRes.json();
      const titleTokens = [doc.title, doc.slug, doc.content]
        .filter(Boolean)
        .map((value) => String(value).toLowerCase().trim())
        .filter(Boolean);
      const memoMatches = (json.data ?? []).filter((memo: SourceMemo) => {
        const haystack = `${memo.title ?? ''} ${memo.content ?? ''}`.toLowerCase();
        return titleTokens.some((token) => haystack.includes(token));
      });
      setSourceMemos(memoMatches.slice(0, 5));
    }
  }, [projectId]);

  const handleSelectDoc = useCallback(async (
    slug: string,
    options?: { commentId?: string | null; updateUrl?: boolean },
  ) => {
    if (!projectId) return false;
    try {
      const res = await fetch(`/api/docs?project_id=${projectId}&slug=${slug}`);
      if (!res.ok) {
        setSelectedDoc(null);
        setComments([]);
        setRevisions([]);
        setSourceMemos([]);
        setServerUpdatedAt(null);
        setPreviewRevisionId(null);
        if (options?.updateUrl !== false) replaceDocSearchParams(null, null);
        return false;
      }

      const json = await res.json();
      const doc = json.data as DocDetail;
      applyLoadedDoc(doc);
      setTree((prev) => {
        const summary: Doc = {
          id: doc.id,
          parent_id: doc.parent_id ?? null,
          title: doc.title,
          slug: doc.slug,
          icon: doc.icon ?? null,
          sort_order: doc.sort_order ?? 0,
          is_folder: doc.is_folder ?? false,
        };
        const next = prev.filter((entry) => entry.id !== summary.id);
        return [summary, ...next];
      });
      setSourceMemos([]);
      closeDocsPanelDrawer();
      if (options?.updateUrl !== false) replaceDocSearchParams(doc.slug, options?.commentId ?? null);
      void loadDocExtras(doc).catch(() => {});
      return true;
    } catch {
      if (options?.updateUrl !== false) replaceDocSearchParams(null, null);
      return false;
    }
  }, [applyLoadedDoc, closeDocsPanelDrawer, loadDocExtras, projectId, replaceDocSearchParams]);

  const handleSearch = useCallback(async () => {
    if (!projectId) {
      setSearchResults([]);
      setNextCursor(null);
      return;
    }

    if (!searchQuery.trim()) {
      setSearchResults([]);
      try {
        const res = await fetch(`/api/docs?project_id=${projectId}&view=tree`);
        if (res.ok) {
          const json = await res.json();
          setTree(json.data);
          setNextCursor(null);
        }
      } catch {
        // noop
      }
      return;
    }

    try {
      const res = await fetch(`/api/docs?project_id=${projectId}&q=${encodeURIComponent(searchQuery)}&limit=40`);
      if (res.ok) {
        const json = await res.json();
        setSearchResults(json.data);
        setNextCursor(json.meta?.nextCursor ?? null);
      }
    } catch {
      // noop
    }
  }, [projectId, searchQuery]);

  useEffect(() => {
    const timer = setTimeout(handleSearch, 300);
    return () => clearTimeout(timer);
  }, [handleSearch]);

  const docSavePayload = useMemo(() => ({
    content: editContent,
    content_format: editContentFormat,
    icon: editIcon.trim() || null,
    tags: parseTagsInput(editTagsInput),
  }), [editContent, editContentFormat, editIcon, editTagsInput]);

  const { status: saveStatus, isDirty, save, clearSyncAlerts } = useDocSync<DocDetail>({
    docId: selectedDoc?.id ?? null,
    savePayload: docSavePayload,
    serverUpdatedAt,
    editing,
    onSaved: (doc) => {
      applyLoadedDoc(doc, { preserveEditing: true, preserveEditorMode: true });
      void loadDocExtras(doc).catch(() => {});
    },
  });

  const refreshSelectedDoc = useCallback(async (options?: { preserveEditing?: boolean; preserveEditorMode?: boolean }) => {
    if (!projectId || !selectedDoc) return false;

    try {
      const res = await fetch(`/api/docs?project_id=${projectId}&slug=${selectedDoc.slug}`);
      if (!res.ok) return false;

      const json = await res.json();
      const doc = json.data as DocDetail;
      applyLoadedDoc(doc, {
        preserveEditing: options?.preserveEditing,
        preserveEditorMode: options?.preserveEditorMode,
      });
      void loadDocExtras(doc).catch(() => {});
      clearSyncAlerts(options?.preserveEditing ? 'saved' : 'idle');
      return true;
    } catch {
      return false;
    }
  }, [applyLoadedDoc, clearSyncAlerts, loadDocExtras, projectId, selectedDoc]);

  const handleSave = useCallback(async (options?: { exitEditing?: boolean; forceOverwrite?: boolean }) => {
    const saved = await save({ force: options?.forceOverwrite });
    if (saved && options?.exitEditing) {
      setEditing(false);
    }
    return saved;
  }, [save]);

  const handleRestoreRevision = useCallback((revision: Revision) => {
    const fallbackFormat = selectedDoc?.content_format ?? 'markdown';
    const restored = getRestoredRevisionDraft(revision, fallbackFormat);
    const nextStatus = restored.content === (selectedDoc?.content ?? '')
      && restored.contentFormat === fallbackFormat
      ? 'saved'
      : 'unsaved';

    setPreviewRevisionId(revision.id);
    setEditContent(restored.content);
    setEditContentFormat(restored.contentFormat);
    setEditorMode('write');
    setEditing(true);
    clearSyncAlerts(nextStatus);
  }, [clearSyncAlerts, selectedDoc?.content, selectedDoc?.content_format]);

  useEffect(() => {
    if (!projectId || !selectedDocSlug || selectedDoc?.slug === selectedDocSlug) return;

    const timer = window.setTimeout(() => {
      void (async () => {
        const loaded = await handleSelectDoc(selectedDocSlug, {
          commentId: selectedCommentId,
          updateUrl: false,
        });

        if (!loaded) replaceDocSearchParams(null, null);
      })();
    }, 0);

    return () => window.clearTimeout(timer);
  }, [handleSelectDoc, projectId, replaceDocSearchParams, selectedCommentId, selectedDoc?.slug, selectedDocSlug]);

  useEffect(() => {
    if (!selectedDoc || !selectedCommentId) return;

    const targetComment = comments.find((comment) => comment.id === selectedCommentId);
    const fallbackTargetId = 'doc-comments-section';

    const timeout = window.setTimeout(() => {
      const element = document.getElementById(targetComment ? `doc-comment-${targetComment.id}` : fallbackTargetId);
      element?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 0);

    return () => window.clearTimeout(timeout);
  }, [comments, selectedCommentId, selectedDoc]);

  const handleOpenCreatePanel = useCallback(() => {
    setShowCreate(true);
    openDocsPanel();
  }, [openDocsPanel]);

  const handleCreate = async () => {
    if (!newTitle.trim() || !newSlug.trim()) return;
    try {
      const res = await fetch('/api/docs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: newTitle.trim(),
          slug: newSlug.trim(),
          is_folder: newIsFolder,
          content_format: 'markdown',
        }),
      });
      if (res.ok) {
        const json = await res.json();
        setTree((prev) => [...prev, json.data]);
        setNewTitle('');
        setNewSlug('');
        setNewIsFolder(false);
        setShowCreate(false);
        closeDocsPanelDrawer();
        await handleSelectDoc(json.data.slug, { updateUrl: true });
      } else {
        const errJson = await res.json().catch(() => null);
        if (errJson?.error?.code === 'UPGRADE_REQUIRED') setUpgradeMessage(errJson.error.message);
      }
    } catch {
      // noop
    }
  };

  const selectedDocTags = useMemo(() => (selectedDoc?.tags ?? []).filter(Boolean), [selectedDoc?.tags]);
  const selectedDocHeadings = useMemo(() => {
    if (!selectedDoc || editing) return [];
    return extractDocHeadings(selectedDoc.content ?? '', selectedDoc.content_format ?? 'markdown');
  }, [editing, selectedDoc]);
  const currentActiveHeadingId = useMemo(() => {
    if (!selectedDocHeadings.length) return null;
    return selectedDocHeadings.some((heading) => heading.id === activeHeadingId)
      ? activeHeadingId
      : selectedDocHeadings[0]?.id ?? null;
  }, [activeHeadingId, selectedDocHeadings]);

  useEffect(() => {
    if (viewMode !== 'docs' || docsPanelSupportsInline || docsPanelDrawerOpen || loading || autoOpenedDocsPanelRef.current) return;
    if (selectedDoc || tree.length === 0) return;

    autoOpenedDocsPanelRef.current = true;
    openDocsPanel();
  }, [docsPanelDrawerOpen, docsPanelSupportsInline, loading, openDocsPanel, selectedDoc, tree.length, viewMode]);

  useEffect(() => {
    if (editing || !selectedDocHeadings.length) return;

    const root = contentContainerRef.current;
    if (!root) return;

    const headingElements = selectedDocHeadings
      .map((heading) => root.querySelector<HTMLElement>(`[id="${heading.id}"]`))
      .filter((heading): heading is HTMLElement => Boolean(heading));

    if (!headingElements.length) return;

    const observer = new IntersectionObserver((entries) => {
      const visible = entries
        .filter((entry) => entry.isIntersecting)
        .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);

      if (visible[0]?.target instanceof HTMLElement) {
        setActiveHeadingId(visible[0].target.id);
      }
    }, {
      rootMargin: '0px 0px -72% 0px',
      threshold: [0, 1],
    });

    headingElements.forEach((heading) => observer.observe(heading));
    return () => observer.disconnect();
  }, [editing, selectedDocHeadings]);

  if (!projectId) {
    return (
      <div className="min-h-screen bg-[color:var(--operator-bg)] p-4 text-[color:var(--operator-foreground)] sm:p-6">
        <div className="mx-auto max-w-7xl space-y-6">
          <PageHeader
            eyebrow={viewMode === 'policy' ? t('tabPolicyDocs') : t('tabDocs')}
            title={t('title')}
            actions={(
              <div className="flex flex-wrap gap-2">
                <Button variant={viewMode === 'docs' ? 'hero' : 'glass'} size="sm" onClick={() => setViewMode('docs')}>
                  {t('tabDocs')}
                </Button>
                <Button variant={viewMode === 'policy' ? 'hero' : 'glass'} size="sm" onClick={() => setViewMode('policy')}>
                  {t('tabPolicyDocs')}
                </Button>
              </div>
            )}
          />
          <SectionCard>
            <SectionCardBody>
              <EmptyState title={shellT('projectSelectPrompt')} description={shellT('projectSelectDescription')} />
            </SectionCardBody>
          </SectionCard>
        </div>
      </div>
    );
  }

  const displayDocs = searchQuery.trim() ? searchResults : tree;
  const previewRevision = previewRevisionId ? revisions.find((revision) => revision.id === previewRevisionId) ?? null : null;
  const saveStatusLabelMap: Record<SaveStatus, string> = {
    idle: t('statusSaved'),
    unsaved: t('statusUnsaved'),
    saving: t('statusSaving'),
    saved: t('statusSaved'),
    conflict: t('statusConflict'),
    'remote-changed': t('statusRemoteChanged'),
    error: t('statusError'),
  };
  const saveStatusToneMap: Record<SaveStatus, string> = {
    idle: 'border-emerald-500/20 bg-emerald-500/10 text-emerald-200',
    unsaved: 'border-amber-500/20 bg-amber-500/10 text-amber-200',
    saving: 'border-sky-500/20 bg-sky-500/10 text-sky-200',
    saved: 'border-emerald-500/20 bg-emerald-500/10 text-emerald-200',
    conflict: 'border-rose-500/20 bg-rose-500/10 text-rose-200',
    'remote-changed': 'border-amber-500/20 bg-amber-500/10 text-amber-200',
    error: 'border-rose-500/20 bg-rose-500/10 text-rose-200',
  };

  const sidebarToggleLabel = docsPanelInlineOpen || docsPanelDrawerOpen ? t('hideSidebar') : t('openSidebar');

  const renderDocsSidebar = ({ mode, closePanel }: { mode: 'inline' | 'drawer'; closePanel: () => void }) => (
    <GlassPanel className="flex h-full min-h-0 flex-col overflow-hidden border-white/8 bg-[color:var(--operator-surface-soft)]/75">
      <div className="space-y-4 overflow-y-auto p-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="text-[11px] font-semibold uppercase tracking-[0.22em] text-[color:var(--operator-muted)]">{t('title')}</div>
            {loading ? <div className="mt-1 text-sm text-[color:var(--operator-muted)]">{t('loading')}</div> : null}
          </div>
          <div className="flex items-center gap-2">
            <Button variant="glass" size="sm" onClick={() => setShowCreate((prev) => !prev)}>
              {t('newDoc')}
            </Button>
            {mode === 'drawer' ? (
              <Button
                variant="glass"
                size="icon-sm"
                aria-label={t('closeSidebar')}
                onClick={closePanel}
              >
                <X />
              </Button>
            ) : null}
          </div>
        </div>

        {showCreate && (
          <GlassPanel className="space-y-3 p-3">
            <input
              type="text"
              value={newTitle}
              onChange={(event) => {
                setNewTitle(event.target.value);
                setNewSlug(event.target.value.toLowerCase().replace(/\s+/g, '-').slice(0, 50));
              }}
              placeholder={t('titlePlaceholder')}
              className="w-full rounded-2xl border border-white/8 bg-[color:var(--operator-surface-soft)]/90 px-3 py-2 text-sm text-[color:var(--operator-foreground)] placeholder:text-[color:var(--operator-muted)] focus:border-[color:var(--operator-primary)]/20 focus:outline-none"
            />
            <input
              type="text"
              value={newSlug}
              onChange={(event) => setNewSlug(event.target.value)}
              placeholder={t('slugPlaceholder')}
              className="w-full rounded-2xl border border-white/8 bg-[color:var(--operator-surface-soft)]/90 px-3 py-2 text-sm text-[color:var(--operator-foreground)] placeholder:text-[color:var(--operator-muted)] focus:border-[color:var(--operator-primary)]/20 focus:outline-none"
            />
            <label className="flex items-center gap-2 text-xs text-[color:var(--operator-muted)]">
              <input type="checkbox" checked={newIsFolder} onChange={(event) => setNewIsFolder(event.target.checked)} />
              {t('newFolder')}
            </label>
            <Button variant="hero" size="sm" className="w-full" onClick={handleCreate}>
              {newIsFolder ? t('newFolder') : t('newDoc')}
            </Button>
          </GlassPanel>
        )}

        <input
          type="text"
          value={searchQuery}
          onChange={(event) => setSearchQuery(event.target.value)}
          placeholder={t('searchPlaceholder')}
          className="w-full rounded-2xl border border-white/8 bg-[color:var(--operator-surface-soft)]/90 px-3 py-2 text-sm text-[color:var(--operator-foreground)] placeholder:text-[color:var(--operator-muted)] focus:border-[color:var(--operator-primary)]/20 focus:outline-none"
        />

        {loading ? (
          <div className="space-y-2">{[1, 2, 3].map((item) => <div key={item} className="h-6 animate-pulse rounded-xl bg-white/5" />)}</div>
        ) : displayDocs.length === 0 ? (
          <p className="text-sm text-[color:var(--operator-muted)]">{t('noDocs')}</p>
        ) : (
          <>
            {searchQuery.trim() ? (
              <nav className="space-y-1">
                {searchResults.map((doc) => {
                  const isSelected = selectedDoc?.slug === doc.slug;
                  const icon = doc.icon ?? (doc.is_folder ? '📁' : '📄');
                  return (
                    <button
                      key={doc.id}
                      onClick={() => handleSelectDoc(doc.slug)}
                      className={`flex w-full items-center gap-2 rounded-2xl px-3 py-2 text-left text-sm transition-all ${isSelected ? 'bg-[color:var(--operator-primary)]/14 text-[color:var(--operator-primary-soft)]' : 'text-[color:var(--operator-foreground)]/88 hover:bg-white/6'}`}
                    >
                      <span>{icon}</span>
                      <span className="truncate">{doc.title}</span>
                    </button>
                  );
                })}
              </nav>
            ) : (
              <DocTree docs={tree} selectedSlug={selectedDoc?.slug ?? null} onSelect={handleSelectDoc} emptyFolderLabel={t('noChildDocs')} />
            )}
            {nextCursor ? (
              <div className="pt-3 text-center">
                <Button
                  variant="glass"
                  size="sm"
                  disabled={loadingMore}
                  onClick={async () => {
                    if (!projectId || !nextCursor) return;
                    setLoadingMore(true);
                    const endpoint = searchQuery.trim()
                      ? `/api/docs?project_id=${projectId}&q=${encodeURIComponent(searchQuery)}&limit=40&cursor=${encodeURIComponent(nextCursor)}`
                      : `/api/docs?project_id=${projectId}&limit=40&cursor=${encodeURIComponent(nextCursor)}`;
                    const res = await fetch(endpoint);
                    if (res.ok) {
                      const json = await res.json();
                      const rows = (json.data ?? []) as Doc[];
                      if (searchQuery.trim()) setSearchResults((prev) => [...prev, ...rows]);
                      else setTree((prev) => [...prev, ...rows]);
                      setNextCursor(json.meta?.nextCursor ?? null);
                    }
                    setLoadingMore(false);
                  }}
                >
                  <ChevronDown className="mr-1 size-4" />
                  {loadingMore ? t('loading') : t('loadMore')}
                </Button>
              </div>
            ) : null}
          </>
        )}
      </div>
    </GlassPanel>
  );

  return (
    <div className="min-h-screen bg-[color:var(--operator-bg)] p-4 text-[color:var(--operator-foreground)] sm:p-6">
      <div className="mx-auto max-w-7xl space-y-6">
        <PageHeader
          eyebrow={viewMode === 'policy' ? t('tabPolicyDocs') : t('tabDocs')}
          title={t('title')}
          actions={(
            <div className="flex flex-wrap gap-2">
              {viewMode === 'docs' ? (
                <>
                  <Button variant="glass" size="sm" onClick={toggleDocsPanel}>
                    <Menu />
                    {sidebarToggleLabel}
                  </Button>
                  <Button variant="glass" size="sm" onClick={handleOpenCreatePanel}>
                    <Plus />
                    {t('newDoc')}
                  </Button>
                </>
              ) : null}
              <Button variant={viewMode === 'docs' ? 'hero' : 'glass'} size="sm" onClick={() => setViewMode('docs')}>
                {t('tabDocs')}
              </Button>
              <Button variant={viewMode === 'policy' ? 'hero' : 'glass'} size="sm" onClick={() => setViewMode('policy')}>
                {t('tabPolicyDocs')}
              </Button>
            </div>
          )}
        />

        {viewMode === 'policy' ? (
          <PolicyDocBrowser projectId={projectId ?? undefined} t={t} />
        ) : (
          <ContextualPanelLayout
            renderPanel={renderDocsSidebar}
            inlinePanelOpen={docsPanelInlineOpen}
            drawerOpen={docsPanelDrawerOpen}
            onDrawerOpenChange={setDocsPanelDrawerOpen}
            drawerAriaLabel={t('openSidebar')}
            inlineColumnsClassName="2xl:grid-cols-[300px_minmax(0,1fr)]"
          >
            <GlassPanel className="min-w-0 overflow-hidden">
              <div className="min-w-0 space-y-4 p-3 sm:p-4">
              {selectedDoc ? (
                <>
                  <SectionCard className="border-white/8 bg-white/4">
                    <SectionCardHeader>
                      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                        <div className="space-y-2">
                          <div className="flex items-start gap-3">
                            {selectedDoc.icon ? (
                              <div className="flex size-12 shrink-0 items-center justify-center rounded-2xl border border-white/10 bg-white/6 text-2xl">
                                {selectedDoc.icon}
                              </div>
                            ) : null}
                            <div>
                              <h1 className="text-2xl font-bold text-[color:var(--operator-foreground)]">{selectedDoc.title}</h1>
                              <p className="mt-1 text-xs text-[color:var(--operator-muted)]">{t('lastUpdated')}: {new Date(selectedDoc.updated_at).toLocaleString()}</p>
                              {selectedDocTags.length ? (
                                <div className="mt-2 flex flex-wrap gap-2">
                                  {selectedDocTags.map((tag) => (
                                    <span key={tag} className="inline-flex items-center rounded-full border border-white/10 bg-white/6 px-2.5 py-1 text-[11px] font-medium uppercase tracking-[0.14em] text-[color:var(--operator-muted)]">
                                      {tag}
                                    </span>
                                  ))}
                                </div>
                              ) : null}
                            </div>
                          </div>
                          <div className="flex flex-wrap items-center gap-2 text-xs">
                            <span className={`inline-flex items-center rounded-full border px-2.5 py-1 font-medium ${saveStatusToneMap[saveStatus]}`}>
                              {saveStatusLabelMap[saveStatus]}
                            </span>
                            {editing ? (
                              <span className="inline-flex items-center rounded-full border border-white/10 bg-white/5 px-2.5 py-1 text-[color:var(--operator-muted)]">
                                {t('autosaveOn')}
                              </span>
                            ) : null}
                            {editing && (saveStatus === 'remote-changed' || saveStatus === 'conflict') ? (
                              <>
                                <Button
                                  variant="glass"
                                  size="sm"
                                  onClick={() => {
                                    void refreshSelectedDoc({ preserveEditing: true, preserveEditorMode: true });
                                  }}
                                >
                                  {isDirty ? t('conflictReload') : t('remoteRefresh')}
                                </Button>
                                {isDirty ? (
                                  <Button
                                    variant="glass"
                                    size="sm"
                                    onClick={() => {
                                      void handleSave({ forceOverwrite: true });
                                    }}
                                  >
                                    {t('conflictOverwrite')}
                                  </Button>
                                ) : null}
                              </>
                            ) : null}
                          </div>
                        </div>
                        <div className="flex flex-wrap items-center gap-2">
                          <Button variant="glass" size="sm" className="2xl:hidden" onClick={openDocsPanel}>
                            <Menu />
                            {t('openSidebar')}
                          </Button>
                          <Button
                            variant={editing ? 'hero' : 'glass'}
                            size="sm"
                            onClick={() => {
                              if (editing) {
                                void handleSave({ exitEditing: true });
                                return;
                              }
                              setEditContent(selectedDoc.content ?? '');
                              setEditContentFormat(selectedDoc.content_format ?? 'markdown');
                              setEditIcon(selectedDoc.icon ?? '');
                              setEditTagsInput((selectedDoc.tags ?? []).join(', '));
                              setEditorMode('write');
                              clearSyncAlerts('saved');
                              setEditing(true);
                            }}
                          >
                            {saveStatus === 'saving' ? t('statusSaving') : editing ? t('save') : t('edit')}
                          </Button>
                        </div>
                      </div>
                    </SectionCardHeader>
                    <SectionCardBody>
                      {editing ? (
                        <div className="space-y-4">
                          <div className="grid gap-4 rounded-2xl border border-white/8 bg-white/4 p-4 lg:grid-cols-[160px_minmax(0,1fr)]">
                            <div className="space-y-2">
                              <label className="text-xs font-medium uppercase tracking-[0.16em] text-[color:var(--operator-muted)]">
                                {t('docIconLabel')}
                              </label>
                              <input
                                type="text"
                                value={editIcon}
                                onChange={(event) => setEditIcon(event.target.value)}
                                placeholder={t('docIconPlaceholder')}
                                maxLength={8}
                                className="w-full rounded-2xl border border-white/8 bg-[color:var(--operator-surface-soft)]/90 px-3 py-2 text-sm text-[color:var(--operator-foreground)] placeholder:text-[color:var(--operator-muted)] focus:border-[color:var(--operator-primary)]/20 focus:outline-none"
                              />
                            </div>
                            <div className="space-y-2">
                              <label className="text-xs font-medium uppercase tracking-[0.16em] text-[color:var(--operator-muted)]">
                                {t('docTagsLabel')}
                              </label>
                              <input
                                type="text"
                                value={editTagsInput}
                                onChange={(event) => setEditTagsInput(event.target.value)}
                                placeholder={t('docTagsPlaceholder')}
                                className="w-full rounded-2xl border border-white/8 bg-[color:var(--operator-surface-soft)]/90 px-3 py-2 text-sm text-[color:var(--operator-foreground)] placeholder:text-[color:var(--operator-muted)] focus:border-[color:var(--operator-primary)]/20 focus:outline-none"
                              />
                              <p className="text-xs text-[color:var(--operator-muted)]">{t('docTagsHint')}</p>
                            </div>
                          </div>

                          <DocEditor
                            value={editContent}
                            contentFormat={editContentFormat}
                            onChange={setEditContent}
                            onContentFormatChange={setEditContentFormat}
                            labels={{
                              contentFormat: t('contentFormat'),
                              markdown: t('formatMarkdown'),
                              html: t('formatHtml'),
                              toolbar: t('toolbar'),
                              hint: t('toolbarHint'),
                              placeholder: t('editorPlaceholder'),
                              h1: t('toolbarH1'),
                              h2: t('toolbarH2'),
                              bold: t('toolbarBold'),
                              italic: t('toolbarItalic'),
                              bullet: t('toolbarBullet'),
                              quote: t('toolbarQuote'),
                              code: t('toolbarCode'),
                              link: t('toolbarLink'),
                            }}
                          />
                        </div>
                      ) : !selectedDoc.content || selectedDoc.content.trim() === '' ? (
                        <div className="text-sm italic text-[color:var(--operator-muted)]">{t('emptyDoc')}</div>
                      ) : (
                        <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_250px] xl:items-start">
                          <DocContentRenderer
                            contentRef={contentContainerRef}
                            content={selectedDoc.content}
                            contentFormat={selectedDoc.content_format ?? 'markdown'}
                            codeCopyLabel={t('codeCopy')}
                            codeCopiedLabel={t('codeCopied')}
                          />
                          <div className="rounded-2xl border border-white/8 bg-white/4 p-4 xl:sticky xl:top-4">
                            <div className="mb-3 text-sm font-semibold text-[color:var(--operator-foreground)]">{t('tocSection')}</div>
                            {selectedDocHeadings.length ? (
                              <nav className="space-y-1.5">
                                {selectedDocHeadings.map((heading) => {
                                  const isActive = currentActiveHeadingId === heading.id;
                                  return (
                                    <button
                                      key={heading.id}
                                      type="button"
                                      onClick={() => {
                                        const element = contentContainerRef.current?.querySelector<HTMLElement>(`[id="${heading.id}"]`);
                                        element?.scrollIntoView({ behavior: 'smooth', block: 'start' });
                                      }}
                                      className={`flex w-full items-center rounded-2xl px-3 py-2 text-left text-sm transition ${isActive ? 'bg-[color:var(--operator-primary)]/14 text-[color:var(--operator-primary-soft)]' : 'text-[color:var(--operator-muted)] hover:bg-white/6 hover:text-[color:var(--operator-foreground)]'}`}
                                      style={{ paddingLeft: `${heading.level === 1 ? 12 : heading.level === 2 ? 20 : 28}px` }}
                                    >
                                      <span className="truncate">{heading.text}</span>
                                    </button>
                                  );
                                })}
                              </nav>
                            ) : (
                              <p className="text-sm text-[color:var(--operator-muted)]">{t('tocEmpty')}</p>
                            )}
                          </div>
                        </div>
                      )}
                    </SectionCardBody>
                  </SectionCard>

                  <div className="grid gap-4 xl:grid-cols-2">
                    <SectionCard className="border-white/8 bg-white/4" id="doc-comments-section">
                      <SectionCardHeader>
                        <div className="text-sm font-semibold">{t('commentsSection')}</div>
                      </SectionCardHeader>
                      <SectionCardBody className="space-y-3">
                        {comments.length ? comments.map((comment) => {
                          const isHighlighted = selectedCommentId === comment.id;
                          return (
                            <div
                              key={comment.id}
                              id={`doc-comment-${comment.id}`}
                              className={`rounded-2xl border p-3 text-sm transition ${isHighlighted
                                ? 'border-[color:var(--operator-primary)]/40 bg-[color:var(--operator-primary)]/12 shadow-[0_0_0_1px_rgba(124,58,237,0.25)]'
                                : 'border-white/8 bg-white/5'
                              }`}
                            >
                              <div className="text-xs text-[color:var(--operator-muted)]">{new Date(comment.created_at).toLocaleString()}</div>
                              <p className="mt-2 whitespace-pre-wrap text-[color:var(--operator-foreground)]">{comment.content}</p>
                            </div>
                          );
                        }) : <p className="text-sm text-[color:var(--operator-muted)]">{t('noComments')}</p>}
                      </SectionCardBody>
                    </SectionCard>
                    <SectionCard className="border-white/8 bg-white/4">
                      <SectionCardHeader><div className="text-sm font-semibold">{t('revisionsSection')}</div></SectionCardHeader>
                      <SectionCardBody className="space-y-3">
                        {previewRevision ? (
                          <div className="space-y-3 rounded-2xl border border-[color:var(--operator-primary)]/20 bg-[color:var(--operator-primary)]/8 p-3">
                            <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-[color:var(--operator-muted)]">
                              <span>{new Date(previewRevision.created_at).toLocaleString()}</span>
                              <Button variant="glass" size="sm" onClick={() => setPreviewRevisionId(null)}>
                                {t('revisionClosePreview')}
                              </Button>
                            </div>
                            <DocContentRenderer
                              content={previewRevision.content}
                              contentFormat={getRevisionContentFormat(previewRevision, selectedDoc.content_format ?? 'markdown')}
                              className="prose-sm max-w-none text-foreground"
                              codeCopyLabel={t('codeCopy')}
                              codeCopiedLabel={t('codeCopied')}
                            />
                          </div>
                        ) : null}
                        {revisions.length ? revisions.map((revision) => (
                          <div key={revision.id} className="rounded-2xl border border-white/8 bg-white/5 p-3 text-sm">
                            <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-[color:var(--operator-muted)]">
                              <span>{new Date(revision.created_at).toLocaleString()}</span>
                              <div className="flex flex-wrap gap-2">
                                <Button variant="glass" size="sm" onClick={() => setPreviewRevisionId(revision.id)}>
                                  {t('revisionPreview')}
                                </Button>
                                <Button variant="glass" size="sm" onClick={() => handleRestoreRevision(revision)}>
                                  {t('revisionRestore')}
                                </Button>
                              </div>
                            </div>
                            <p className="mt-2 line-clamp-3 whitespace-pre-wrap text-[color:var(--operator-foreground)]">{revision.content}</p>
                          </div>
                        )) : <p className="text-sm text-[color:var(--operator-muted)]">{t('noRevisions')}</p>}
                      </SectionCardBody>
                    </SectionCard>
                  </div>

                  <SectionCard className="border-white/8 bg-white/4">
                    <SectionCardHeader><div className="text-sm font-semibold">{t('sourceMemosSection')}</div></SectionCardHeader>
                    <SectionCardBody className="space-y-3">{sourceMemos.length ? sourceMemos.map((memo) => <div key={memo.id} className="rounded-2xl border border-white/8 bg-white/5 p-3 text-sm"><div className="flex items-center justify-between gap-2 text-xs text-[color:var(--operator-muted)]"><span>{new Date(memo.created_at).toLocaleString()}</span><span className="capitalize">{memo.status}</span></div><p className="mt-2 font-medium text-[color:var(--operator-foreground)]">{memo.title ?? memo.content.slice(0, 80)}</p><p className="mt-1 line-clamp-2 whitespace-pre-wrap text-[color:var(--operator-muted)]">{memo.content}</p></div>) : <p className="text-sm text-[color:var(--operator-muted)]">{t('noSourceMemos')}</p>}</SectionCardBody>
                  </SectionCard>
                </>
              ) : (
                <GlassPanel className="flex min-h-[40vh] items-center justify-center border-white/8 bg-white/4 p-6 text-sm text-[color:var(--operator-muted)]">
                  {t('selectDoc')}
                </GlassPanel>
              )}
              </div>
            </GlassPanel>
          </ContextualPanelLayout>
        )}
      </div>

      {upgradeMessage && <UpgradeModal message={upgradeMessage} onClose={() => setUpgradeMessage(null)} />}
    </div>
  );
}
