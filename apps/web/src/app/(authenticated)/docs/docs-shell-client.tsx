'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { DocTree } from '@/components/docs/doc-tree';
import { DocEditor } from '@/components/docs/doc-editor';
import { useDocSync, type SaveStatus } from '@/components/docs/use-doc-sync';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ToastContainer, useToast } from '@/components/ui/toast';
import { Plus, X, Trash2 } from 'lucide-react';

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

  // Always-editable content states
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [contentFormat, setContentFormat] = useState<'markdown' | 'html'>('markdown');

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

  const fetchTree = useCallback(async () => {
    if (!projectId) return;

    try {
      const res = await fetch(`/api/docs?project_id=${projectId}&view=tree`);
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
  }, [fetchDoc, router, searchParams]);

  const handleReorder = useCallback(async (docId: string, newSortOrder: number, siblings: Doc[]) => {
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
    fetchTree();
  }, [fetchTree]);

  useEffect(() => {
    const slug = searchParams.get('slug');
    if (slug) void fetchDoc(slug);
  }, [searchParams, fetchDoc]);

  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center">
        <p className="text-sm text-gray-400">{t('loading')}</p>
      </div>
    );
  }

  return (
    <div className="flex h-screen">
      {/* Left: Doc Tree */}
      <div className="w-80 flex-shrink-0 border-r border-gray-800 flex flex-col">
        <div className="flex-shrink-0 border-b border-gray-800 px-4 py-3">
          <div className="flex items-center justify-between">
            <h1 className="text-lg font-semibold">{t('title')}</h1>
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
        <div className="flex-1 overflow-y-auto p-2">
          <DocTree
            docs={tree}
            selectedSlug={selectedDoc?.slug || null}
            onSelect={handleSelectDoc}
            onReorder={handleReorder}
            onMove={handleMove}
            onMoveDenied={handleMoveDenied}
            onRename={handleRename}
            onDelete={handleDeleteDoc}
            onAddChild={handleAddChild}
          />
        </div>
      </div>

      {/* Right: Doc Content or Create Form */}
      <div className="flex-1 flex flex-col bg-gray-900">
        {showCreate ? (
          <div className="flex h-full flex-col">
            <div className="flex-shrink-0 border-b border-gray-800 px-6 py-4">
              <div className="flex items-center justify-between">
                <h2 className="text-2xl font-semibold">{t('newDoc')}</h2>
                <Button variant="ghost" size="sm" onClick={() => {
                  setShowCreate(false);
                  setNewParentId(null);
                }}>
                  <X className="h-4 w-4" />
                </Button>
              </div>
            </div>
            <div className="flex-1 overflow-y-auto px-6 py-6">
              <div className="space-y-4 max-w-3xl">
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
                    className="w-full min-h-[200px] rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 text-sm resize-none"
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
            <div className="flex-shrink-0 border-b border-gray-800 px-6 py-4">
              <div className="flex items-center justify-between gap-4">
                <div className="flex-1 min-w-0">
                  <Input
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    className="text-2xl font-semibold border-none bg-transparent px-0 focus-visible:ring-0"
                    placeholder={t('titlePlaceholder')}
                  />
                </div>
                <div className="flex items-center gap-3">
                  <SaveStatusIndicator status={saveStatus} t={t} />
                  <Button variant="ghost" size="sm" onClick={handleDelete}>
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            </div>

            {/* Content — always-editable tiptap */}
            <div className="flex-1 overflow-y-auto px-6 py-6">
              <DocEditor
                value={content}
                contentFormat={contentFormat}
                editable={true} // TODO: pass per-doc permission when RBAC is introduced (e.g. canEdit ?? true)
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
          <div className="flex h-full items-center justify-center">
            <p className="text-sm text-gray-400">{t('selectDoc')}</p>
          </div>
        )}
      </div>
      <ToastContainer toasts={toasts} onDismiss={dismissToast} />
    </div>
  );
}
