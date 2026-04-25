'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { DocTree } from '@/components/docs/doc-tree';
import { DocEditor } from '@/components/docs/doc-editor';
import { useDocSync, type SaveStatus } from '@/components/docs/use-doc-sync';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Input } from '@/components/ui/input';
import { ToastContainer, useToast } from '@/components/ui/toast';
import { ChevronLeft, Plus, X, Trash2, Copy, Check } from 'lucide-react';
import { DocsShell } from '@/components/docs/docs-shell';
import { GlassPanel } from '@/components/ui/glass-panel';

interface Doc {
  id: string;
  parent_id: string | null;
  title: string;
  slug: string;
  icon: string | null;
  sort_order: number;
  is_folder?: boolean;
}

interface DocDetail {
  id: string;
  title: string;
  slug: string;
  content: string;
  content_format?: 'markdown' | 'html';
  updated_at: string;
  parent_id?: string | null;
  icon?: string | null;
  is_folder?: boolean;
  doc_type?: string;
  org_id?: string;
}

interface DocsShellClientProps {
  projectId?: string;
}

/** Pure helper — exported for unit tests */
export function getDocSaveStatusText(status: SaveStatus, t: (key: string) => string): string | null {
  const map: Partial<Record<SaveStatus, string>> = {
    saving: t('statusSaving'),
    saved: t('statusSaved'),
    unsaved: t('statusUnsaved'),
    error: t('statusError'),
    conflict: t('statusConflict'),
    'remote-changed': t('statusRemoteChanged'),
  };
  return map[status] ?? null;
}

const SAVE_STATUS_CLASS: Partial<Record<SaveStatus, string>> = {
  saving: 'text-[color:var(--operator-muted)]',
  saved: 'text-emerald-500/70',
  unsaved: 'text-amber-500/70',
  error: 'text-rose-500',
  conflict: 'text-rose-500',
  'remote-changed': 'text-amber-500',
};

function SaveStatusIndicator({ status, t }: { status: SaveStatus; t: ReturnType<typeof useTranslations> }) {
  const text = getDocSaveStatusText(status, t);
  if (!text) return null;

  return <span className={`shrink-0 text-xs ${SAVE_STATUS_CLASS[status] ?? ''}`}>{text}</span>;
}

/**
 * Docs shell with 2-panel layout (tree + content).
 * Notion-style: always-editable tiptap, autosave via useDocSync.
 */
export function DocsShellClient({ projectId }: DocsShellClientProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const t = useTranslations('docs');
  const tc = useTranslations('common');
  const { toasts, addToast, dismissToast } = useToast();

  const [tree, setTree] = useState<Doc[]>([]);
  const [selectedDoc, setSelectedDoc] = useState<DocDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [mobileView, setMobileView] = useState<'list' | 'detail'>('list');
  const [selectedTags, setSelectedTags] = useState<string[]>([]);

  // Always-editable content states
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [contentFormat, setContentFormat] = useState<'markdown' | 'html'>('markdown');
  const [mdCopied, setMdCopied] = useState(false);

  const handleCopyMarkdown = useCallback(async () => {
    try {
      if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(content);
      }
    } catch {
      // clipboard unavailable
    }
    setMdCopied(true);
    window.setTimeout(() => setMdCopied(false), 1600);
  }, [content]);

  // Create form states
  const [showCreate, setShowCreate] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [newContent, setNewContent] = useState('');
  const [newSlug, setNewSlug] = useState('');
  const [newParentId, setNewParentId] = useState<string | null>(null);
  const [slugManuallyEdited, setSlugManuallyEdited] = useState(false);

  const handleDocSaved = useCallback((doc: DocDetail) => {
    setSelectedDoc(doc);
    setTree((prev) =>
      prev.map((d) => (d.id === doc.id ? { ...d, title: doc.title } : d))
    );
  }, []);

  const { status: saveStatus } = useDocSync<DocDetail>({
    docId: selectedDoc?.id ?? null,
    savePayload: { title, content, content_format: contentFormat },
    serverUpdatedAt: selectedDoc?.updated_at ?? null,
    editing: selectedDoc !== null,
    onSaved: handleDocSaved,
  });

  const fetchTree = useCallback(async (tags?: string[]) => {
    if (!projectId) return;

    try {
      const params = new URLSearchParams({ project_id: projectId });
      if (tags?.length) params.set('tags', tags.join(','));
      else params.set('view', 'tree');
      const res = await fetch(`/api/docs?${params.toString()}`);
      if (!res.ok) throw new Error('Failed to fetch tree');

      const { data } = await res.json();
      setTree(data || []);
    } catch (error) {
      console.error('Failed to fetch docs tree:', error);
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  const fetchDoc = useCallback(async (slug: string) => {
    if (!projectId) return;

    try {
      const res = await fetch(`/api/docs?project_id=${projectId}&slug=${slug}`);
      if (!res.ok) throw new Error('Failed to fetch doc');

      const { data } = await res.json();
      setSelectedDoc(data);
      setTitle(data.title);
      setContent(data.content);
      setContentFormat(data.content_format || 'markdown');
    } catch (error) {
      console.error('Failed to fetch doc:', error);
      setSelectedDoc(null);
    }
  }, [projectId]);

  const handleSelectDoc = useCallback((slug: string) => {
    void fetchDoc(slug);
    const params = new URLSearchParams(searchParams);
    params.set('slug', slug);
    router.replace(`?${params.toString()}`);
    setMobileView('detail');
  }, [fetchDoc, router, searchParams]);

  const handleReorder = useCallback(async (docId: string, newSortOrder: number) => {
    setTree((prev) =>
      prev.map((doc) => (doc.id === docId ? { ...doc, sort_order: newSortOrder } : doc))
    );

    try {
      const res = await fetch(`/api/docs/${docId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sort_order: newSortOrder }),
      });

      if (!res.ok) await fetchTree();
    } catch (error) {
      console.error('Failed to reorder doc:', error);
      await fetchTree();
    }
  }, [fetchTree]);

  const handleMove = useCallback(async (docId: string, newParentId: string | null, newSortOrder: number) => {
    // Optimistic update
    setTree((prev) =>
      prev.map((doc) =>
        doc.id === docId ? { ...doc, parent_id: newParentId, sort_order: newSortOrder } : doc
      )
    );

    try {
      const res = await fetch(`/api/docs/${docId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ parent_id: newParentId, sort_order: newSortOrder }),
      });

      if (!res.ok) {
        await fetchTree();
      }
    } catch (error) {
      console.error('Failed to move doc:', error);
      await fetchTree();
    }
  }, [fetchTree]);

  const handleMoveDenied = useCallback((reason: 'circular' | 'no-permission') => {
    if (reason === 'circular') {
      addToast({ title: t('moveCircularError'), type: 'error' });
    } else {
      addToast({ title: t('movePermissionError'), type: 'warning' });
    }
  }, [addToast, t]);

  const handleRename = useCallback(async (docId: string, newName: string) => {
    setTree((prev) =>
      prev.map((doc) => (doc.id === docId ? { ...doc, title: newName } : doc))
    );

    try {
      const res = await fetch(`/api/docs/${docId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: newName }),
      });

      if (!res.ok) {
        await fetchTree();
      } else if (selectedDoc?.id === docId) {
        // Parse full response so updated_at propagates to useDocSync → resets lastSavedSnapshot
        // preventing a spurious autosave PATCH after handleRename's own PATCH.
        const { data } = (await res.json()) as { data: DocDetail };
        setSelectedDoc(data);
        setTitle(data.title);
      }
    } catch (error) {
      console.error('Failed to rename doc:', error);
      await fetchTree();
    }
  }, [selectedDoc, fetchTree]);

  const handleDeleteDoc = useCallback(async (docId: string) => {
    setTree((prev) => prev.filter((doc) => doc.id !== docId));

    try {
      const res = await fetch(`/api/docs/${docId}`, { method: 'DELETE' });

      if (!res.ok) {
        await fetchTree();
      } else if (selectedDoc?.id === docId) {
        setSelectedDoc(null);
      }
    } catch (error) {
      console.error('Failed to delete doc:', error);
      await fetchTree();
    }
  }, [selectedDoc, fetchTree]);

  const generateSlug = useCallback((s: string): string => {
    return s
      .toLowerCase()
      .trim()
      .replace(/\s+/g, '-')
      .replace(/[^\w\u3131-\uD79D-]/g, '')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '');
  }, []);

  const handleNewTitleChange = useCallback((t: string) => {
    setNewTitle(t);
    if (!slugManuallyEdited) setNewSlug(generateSlug(t));
  }, [slugManuallyEdited, generateSlug]);

  const handleSlugChange = useCallback((slug: string) => {
    setNewSlug(slug);
    setSlugManuallyEdited(true);
  }, []);

  const handleAddChild = useCallback(async (parentId: string) => {
    setNewParentId(parentId);
    setShowCreate(true);
    setNewTitle('');
    setNewContent('');
    setNewSlug('');
    setSlugManuallyEdited(false);
  }, []);

  const handleCreate = useCallback(async () => {
    if (!projectId || !newTitle.trim() || !newSlug.trim()) return;

    try {
      const res = await fetch('/api/docs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          project_id: projectId,
          title: newTitle,
          slug: newSlug,
          content: newContent,
          content_format: 'markdown',
          parent_id: newParentId,
        }),
      });

      if (!res.ok) throw new Error('Failed to create doc');

      const { data } = await res.json();

      setTree((prev) => [
        {
          id: data.id,
          parent_id: data.parent_id || null,
          title: data.title,
          slug: data.slug,
          icon: data.icon || null,
          sort_order: data.sort_order || 0,
          is_folder: data.is_folder || false,
        },
        ...prev,
      ]);

      setSelectedDoc(data);
      setTitle(data.title);
      setContent(data.content);
      setContentFormat(data.content_format || 'markdown');
      setShowCreate(false);
      setNewTitle('');
      setNewSlug('');
      setNewContent('');
      setNewParentId(null);
      setSlugManuallyEdited(false);

      const params = new URLSearchParams(searchParams);
      params.set('slug', data.slug);
      router.replace(`?${params.toString()}`);
    } catch (error) {
      console.error('Failed to create doc:', error);
    }
  }, [projectId, newTitle, newSlug, newContent, newParentId, router, searchParams]);

  const handleDelete = useCallback(async () => {
    if (!selectedDoc || !projectId) return;
    if (!confirm(t('confirmDelete'))) return;

    try {
      const res = await fetch(`/api/docs/${selectedDoc.id}`, { method: 'DELETE' });

      if (!res.ok) throw new Error('Failed to delete doc');

      setTree((prev) => prev.filter((doc) => doc.id !== selectedDoc.id));
      setSelectedDoc(null);
      router.replace('/docs');
    } catch (error) {
      console.error('Failed to delete doc:', error);
    }
  }, [selectedDoc, projectId, router, t]);

  useEffect(() => {
    void fetchTree(selectedTags.length ? selectedTags : undefined);
  }, [fetchTree, selectedTags]);

  useEffect(() => {
    const slug = searchParams.get('slug');
    if (slug) void fetchDoc(slug);
  }, [searchParams, fetchDoc]);

  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center">
        <p className="text-sm text-[color:var(--operator-muted)]">{t('loading')}</p>
      </div>
    );
  }

  const sidebarContent = (
    <>
      <div className="flex-shrink-0 border-b border-white/10 px-4 py-4">
        <div className="flex items-center justify-between gap-2">
          <div className="space-y-1">
            <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-muted-foreground">Knowledge Base</p>
            <h1 className="text-lg font-semibold">{t('title')}</h1>
          </div>
          <Button size="sm" onClick={() => {
            setShowCreate(true);
            setNewTitle('');
            setNewSlug('');
            setNewContent('');
            setNewParentId(null);
            setSlugManuallyEdited(false);
          }}>
            <Plus className="h-4 w-4" />
          </Button>
        </div>
      </div>
      {/* Tag filter chips */}
      {(() => {
        const allTags = [...new Set(tree.flatMap((d) => (d as unknown as { tags?: string[] | null }).tags ?? []))];
        if (allTags.length === 0) return null;
        return (
          <div className="flex flex-wrap gap-1.5 border-b border-white/10 px-4 py-2">
            {allTags.map((tag) => (
              <button
                key={tag}
                type="button"
                onClick={() => setSelectedTags((prev) => prev.includes(tag) ? prev.filter((t) => t !== tag) : [...prev, tag])}
                className={`rounded-full px-2.5 py-0.5 text-[11px] font-medium transition ${selectedTags.includes(tag) ? 'bg-primary text-primary-foreground' : 'bg-muted/60 text-muted-foreground hover:bg-muted'}`}
              >
                #{tag}
              </button>
            ))}
            {selectedTags.length > 0 && (
              <button type="button" onClick={() => setSelectedTags([])} className="text-[11px] text-muted-foreground hover:text-foreground underline">
                {t('clearFilter')}
              </button>
            )}
          </div>
        );
      })()}
      <div className="flex-1 overflow-y-auto p-2">
        {tree.length === 0 ? (
          <EmptyState
            title={t('title')}
            description={t('selectDoc')}
            className="mt-2 bg-background/70"
            action={
              <Button
                size="sm"
                onClick={() => {
                  setShowCreate(true);
                  setNewTitle('');
                  setNewSlug('');
                  setNewContent('');
                  setNewParentId(null);
                  setSlugManuallyEdited(false);
                }}
              >
                <Plus className="mr-1 h-4 w-4" />
                {t('newDoc')}
              </Button>
            }
          />
        ) : (
          <DocTree
            docs={tree}
            selectedSlug={selectedDoc?.slug || null}
            onSelect={(doc) => { handleSelectDoc(doc); }}
            onReorder={handleReorder}
            onMove={handleMove}
            onMoveDenied={handleMoveDenied}
            onRename={handleRename}
            onDelete={handleDeleteDoc}
            onAddChild={handleAddChild}
          />
        )}
      </div>
    </>
  );

  const editorContent = showCreate ? (
          <div className="flex h-full flex-col">
            <div className="flex-shrink-0 border-b border-white/10 px-4 py-3 lg:px-6 lg:py-5">
              <div className="flex items-center justify-between">
                <div className="space-y-1">
                  <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-muted-foreground">Draft</p>
                  <h2 className="text-2xl font-semibold">{t('newDoc')}</h2>
                </div>
                <Button variant="ghost" size="sm" onClick={() => {
                  setShowCreate(false);
                  setNewParentId(null);
                }}>
                  <X className="h-4 w-4" />
                </Button>
              </div>
            </div>
            <div className="flex-1 overflow-y-auto px-4 py-4 lg:px-6 lg:py-6">
              <div className="max-w-3xl space-y-5">
                <div>
                  <label className="text-sm font-medium mb-2 block">{t('titleLabel')}</label>
                  <Input
                    value={newTitle}
                    onChange={(e) => handleNewTitleChange(e.target.value)}
                    placeholder={t('titlePlaceholder')}
                  />
                </div>
                <div>
                  <label className="text-sm font-medium mb-2 block">{t('slugLabel')}</label>
                  <Input
                    value={newSlug}
                    onChange={(e) => handleSlugChange(e.target.value)}
                    placeholder={t('slugPlaceholder')}
                  />
                </div>
                <div>
                  <label className="text-sm font-medium mb-2 block">{t('contentLabel')}</label>
                  <textarea
                    value={newContent}
                    onChange={(e) => setNewContent(e.target.value)}
                    placeholder={t('editorPlaceholder')}
                    className="w-full min-h-[220px] rounded-xl border border-white/10 bg-[color:var(--operator-surface-soft)] px-4 py-3 text-sm resize-none"
                  />
                </div>
                <div className="flex gap-2">
                  <Button onClick={handleCreate} disabled={!newTitle.trim() || !newSlug.trim()}>
                    {tc('create')}
                  </Button>
                  <Button variant="ghost" onClick={() => {
                    setShowCreate(false);
                    setNewParentId(null);
                  }}>
                    {tc('cancel')}
                  </Button>
                </div>
              </div>
            </div>
          </div>
        ) : selectedDoc ? (
          <>
            {/* Header */}
            <div className="flex-shrink-0 border-b border-white/10 px-4 py-3 lg:px-6 lg:py-5">
              <div className="flex items-center justify-between gap-4">
                <div className="flex-1 min-w-0">
                  <Input
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    className="border-none bg-transparent px-0 text-2xl font-semibold focus-visible:ring-0"
                    placeholder={t('titlePlaceholder')}
                  />
                </div>
                <div className="flex items-center gap-3">
                  <SaveStatusIndicator status={saveStatus} t={t} />
                  <Button variant="ghost" size="sm" onClick={handleCopyMarkdown} title="마크다운 복사">
                    {mdCopied ? <Check className="h-4 w-4 text-emerald-500" /> : <Copy className="h-4 w-4" />}
                  </Button>
                  {selectedDoc.doc_type !== 'sprint_report' && (
                    <Button variant="ghost" size="sm" onClick={handleDelete}>
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  )}
                </div>
              </div>
            </div>

            {/* Content — always-editable tiptap */}
            <div className="flex-1 overflow-y-auto px-4 py-4 lg:px-6 lg:py-6">
              <DocEditor
                value={content}
                contentFormat={contentFormat}
                editable={selectedDoc.doc_type !== 'sprint_report'}
                currentDocId={selectedDoc.id}
                onNavigate={handleSelectDoc}
                onChange={setContent}
                onContentFormatChange={setContentFormat}
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
          </>
  ) : (
    <div className="flex h-full items-center justify-center p-4 lg:p-6">
      <EmptyState
        title={t('title')}
        description={t('selectDoc')}
        className="w-full max-w-lg bg-background/70"
        action={
          <Button
            size="sm"
            onClick={() => {
              setShowCreate(true);
              setNewTitle('');
              setNewSlug('');
              setNewContent('');
              setNewParentId(null);
              setSlugManuallyEdited(false);
            }}
          >
            <Plus className="mr-1 h-4 w-4" />
            {t('newDoc')}
          </Button>
        }
      />
    </div>
  );

  return (
    <>
      {/* Desktop layout (lg+) — unchanged 2-panel DocsShell */}
      <div className="hidden lg:block">
        <DocsShell sidebar={sidebarContent} className="min-h-[calc(100vh-8rem)]">
          {editorContent}
        </DocsShell>
      </div>

      {/* Mobile layout (< lg) — list ↔ detail full-screen */}
      <div className="lg:hidden">
        {mobileView === 'detail' ? (
          <div className="space-y-2">
            <button
              type="button"
              onClick={() => setMobileView('list')}
              className="flex items-center gap-1 py-1 text-sm text-[color:var(--operator-muted)] hover:text-[color:var(--operator-foreground)]"
            >
              <ChevronLeft className="size-4" />
              {t('title')}
            </button>
            <GlassPanel className="flex min-h-0 flex-col overflow-hidden shadow-sm">
              {editorContent}
            </GlassPanel>
          </div>
        ) : (
          <GlassPanel className="flex flex-col border-white/8 bg-[color:var(--operator-surface-soft)]/75 shadow-sm">
            {sidebarContent}
          </GlassPanel>
        )}
      </div>

      <ToastContainer toasts={toasts} onDismiss={dismissToast} />
    </>
  );
}
