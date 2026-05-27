'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { DocEditor } from '@/components/docs/doc-editor';
import { useDocSync, type SaveStatus } from '@/components/docs/use-doc-sync';
import { htmlToMarkdown } from '@/components/docs/lib/content-converter';
import Link from 'next/link';
import { AlertTriangle, Check, Copy, Eye, Loader2, MoreHorizontal, RotateCw, Trash2, XCircle } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useDocsLayout } from '../docs-context';
import { EntityDispatchPanel } from '@/components/dispatch/entity-dispatch-panel';
import { DocBreadcrumb } from '@/components/docs/doc-breadcrumb';

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
  assignee_id?: string | null;
}

function InlineSaveIndicator({
  status,
  onAction,
  t,
}: {
  status: SaveStatus;
  onAction: () => void;
  t: ReturnType<typeof useTranslations>;
}) {
  const [show, setShow] = useState(false);
  const [fading, setFading] = useState(false);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (status === 'idle') { setShow(false); setFading(false); return; }
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setShow(true);
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setFading(false);
    if (status !== 'saved') return;
    const t1 = setTimeout(() => setFading(true), 200);
    const t2 = setTimeout(() => setShow(false), 1600);
    return () => { clearTimeout(t1); clearTimeout(t2); };
  }, [status]);

  if (!show) return null;

  if (status === 'saving') {
    return (
      <span aria-label={t('statusSaving')} title={t('statusSaving')} className="flex items-center">
        <Loader2 className="size-3.5 animate-spin text-muted-foreground" />
      </span>
    );
  }
  if (status === 'saved') {
    return (
      <span aria-label={t('statusSaved')} title={t('statusSaved')} className={`flex items-center transition-opacity duration-[1400ms] ${fading ? 'opacity-0' : 'opacity-100'}`}>
        <span className="size-2 rounded-full bg-success" />
      </span>
    );
  }
  if (status === 'unsaved') {
    return (
      <span aria-label={t('statusUnsaved')} title={t('statusUnsaved')} className="flex items-center">
        <span className="size-2 rounded-full bg-warning" />
      </span>
    );
  }
  if (status === 'error') {
    return (
      <button type="button" onClick={onAction}
        aria-label={`${t('statusError')} · ${t('retry')}`}
        title={`${t('statusError')} · ${t('retry')}`}
        className="flex max-w-[120px] items-center gap-1 truncate text-xs text-destructive hover:text-destructive/80 md:max-w-none"
      >
        <XCircle className="size-3.5 shrink-0" />
        <span className="truncate">{t('statusError')} · {t('retry')}</span>
      </button>
    );
  }
  if (status === 'conflict') {
    return (
      <button type="button" onClick={onAction}
        aria-label={t('statusConflict')} title={t('statusConflict')}
        className="flex max-w-[120px] items-center gap-1 truncate text-xs text-destructive hover:text-destructive/80 md:max-w-none"
      >
        <AlertTriangle className="size-3.5 shrink-0" />
        <span className="truncate">{t('statusConflict')}</span>
      </button>
    );
  }
  if (status === 'remote-changed') {
    return (
      <button type="button" onClick={onAction}
        aria-label={t('statusRemoteChanged')} title={t('statusRemoteChanged')}
        className="flex max-w-[120px] items-center gap-1 truncate text-xs text-warning hover:text-warning/80 md:max-w-none"
      >
        <RotateCw className="size-3.5 shrink-0" />
        <span className="truncate">{t('statusRemoteChanged')}</span>
      </button>
    );
  }
  return null;
}

export default function DocSlugPage() {
  const params = useParams();
  const slug = typeof params.slug === 'string' ? params.slug : '';
  const router = useRouter();
  const t = useTranslations('docs');
  // 신규 문서 자동 포커스: URL ?new=1 파라미터를 ref로 처리 (useSearchParams Suspense 이슈 방지)
  const isNewRef = useRef(typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('new') === '1');
  const isNew = isNewRef.current;

  const { projectId, tree, setTree, pendingDocUpdate, clearPendingDocUpdate, expandFolder } = useDocsLayout();

  const [selectedDoc, setSelectedDoc] = useState<DocDetail | null>(null);
  const [docLoading, setDocLoading] = useState(true);
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [contentFormat, setContentFormat] = useState<'markdown' | 'html'>('markdown');
  const [autosave, setAutosave] = useState(true);
  const [mdCopied, setMdCopied] = useState(false);

  const handleDocSaved = useCallback((doc: DocDetail) => {
    setSelectedDoc(doc);
    setTree((prev) => prev.map((d) => (d.id === doc.id ? { ...d, title: doc.title } : d)));
  }, [setTree]);

  const handleTitleChange = useCallback((value: string) => {
    setTitle(value);
    setSelectedDoc((prev) => (prev ? { ...prev, title: value } : null));
    setTree((prev) => prev.map((d) => (d.id === selectedDoc?.id ? { ...d, title: value } : d)));
  }, [selectedDoc?.id, setTree]);

  const { status: saveStatus, isDirty, save } = useDocSync<DocDetail>({
    docId: selectedDoc?.id ?? null,
    savePayload: { title, content, content_format: contentFormat },
    serverUpdatedAt: selectedDoc?.updated_at ?? null,
    editing: selectedDoc !== null,
    autosave,
    onSaved: handleDocSaved,
  });

  const fetchDoc = useCallback(async () => {
    if (!projectId || !slug) return;
    setDocLoading(true);
    try {
      const res = await fetch(`/api/docs?project_id=${projectId}&slug=${slug}`);
      if (!res.ok) {
        setSelectedDoc(null);
        return;
      }
      const json = await res.json();
      const data = json?.data ?? null;
      if (!data) {
        setSelectedDoc(null);
        return;
      }
      setSelectedDoc(data);
      setTitle(data.title ?? '');
      setContent(data.content ?? '');
      setContentFormat(data.content_format ?? 'markdown');
    } catch {
      setSelectedDoc(null);
    } finally {
      setDocLoading(false);
    }
  }, [projectId, slug]);

  useEffect(() => { void fetchDoc(); }, [fetchDoc]);

  // layout handleRename PATCH 성공 후 updated_at 동기화 — useDocSync 기준선 desync 방지
  useEffect(() => {
    if (!pendingDocUpdate || !selectedDoc || pendingDocUpdate.id !== selectedDoc.id) return;
    setSelectedDoc((prev) => prev ? { ...prev, title: pendingDocUpdate.title, updated_at: pendingDocUpdate.updated_at } : null);
    setTitle(pendingDocUpdate.title);
    clearPendingDocUpdate();
  }, [pendingDocUpdate, selectedDoc, clearPendingDocUpdate]);

  const handleCopyMarkdown = useCallback(async () => {
    const md = contentFormat === 'markdown' ? content : htmlToMarkdown(content);
    try {
      if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(md);
      }
    } catch { /* clipboard unavailable */ }
    setMdCopied(true);
    window.setTimeout(() => setMdCopied(false), 1600);
  }, [content, contentFormat]);

  const handleDelete = useCallback(async () => {
    if (!selectedDoc || !projectId) return;
    if (!confirm(t('confirmDelete'))) return;
    try {
      const res = await fetch(`/api/docs/${selectedDoc.id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('Failed to delete doc');
      setTree((prev) => prev.filter((d) => d.id !== selectedDoc.id));
      router.replace('/docs');
    } catch { /* delete failed */ }
  }, [selectedDoc, projectId, router, setTree, t]);

  const handleNavigate = useCallback((targetSlug: string) => {
    router.push(`/docs/${targetSlug}`);
  }, [router]);

  if (docLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-sm text-muted-foreground">{t('loading')}</p>
      </div>
    );
  }

  if (!selectedDoc) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-sm text-muted-foreground">{t('notFound')}</p>
      </div>
    );
  }

  const docActions = (
    <>
      <InlineSaveIndicator status={saveStatus} onAction={save} t={t} />
      <button
        type="button"
        onClick={handleCopyMarkdown}
        title={t('copyMarkdown')}
        aria-label={t('copyMarkdown')}
        className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
      >
        {mdCopied ? <Check className="h-4 w-4 text-success" /> : <Copy className="h-4 w-4" />}
      </button>
      <DropdownMenu>
        <DropdownMenuTrigger className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground">
          <MoreHorizontal className="h-4 w-4" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-48">
          <DropdownMenuItem render={<Link href={`/docs/${slug}/view`} />}>
            <Eye className="mr-2 h-4 w-4" />
            {t('preview')}
          </DropdownMenuItem>
          {selectedDoc.doc_type !== 'sprint_report' && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={handleDelete} className="text-destructive focus:text-destructive">
                <Trash2 className="mr-2 h-4 w-4" />
                {t('deleteDoc')}
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  );

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* Dispatch */}
      {projectId && (
        <div className="flex-shrink-0 border-b border-border px-4 py-2 lg:px-6">
          <EntityDispatchPanel
            entityType="doc"
            entityId={selectedDoc.id}
            projectId={projectId}
            currentAssigneeId={selectedDoc.assignee_id}
            onAssigneePatched={(aid) => setSelectedDoc((prev) => prev ? { ...prev, assignee_id: aid } : prev)}
            mobileMode="assignee-only"
          />
        </div>
      )}

      {/* Editor */}
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden px-4 py-4 lg:px-6 lg:py-6">
        <DocEditor
          value={content}
          contentFormat={contentFormat}
          editable={selectedDoc.doc_type !== 'sprint_report'}
          currentDocId={selectedDoc.id}
          onNavigate={handleNavigate}
          onChange={setContent}
          onContentFormatChange={setContentFormat}
          isDirty={isDirty}
          onSave={save}
          autosave={autosave}
          onAutosaveToggle={setAutosave}
          title={title}
          onTitleChange={handleTitleChange}
          titlePlaceholder={t('titlePlaceholder')}
          titleAutoFocus={isNew || !title}
          breadcrumb={
            tree.length > 0 && selectedDoc ? (
              <DocBreadcrumb
                currentDocId={selectedDoc.id}
                tree={tree}
                onExpandFolder={expandFolder}
                ariaLabel={t('breadcrumbAriaLabel')}
              />
            ) : null
          }
          actions={docActions}
          labels={{
            contentFormat: t('contentFormat'),
            markdown: t('formatMarkdown'),
            preview: t('formatPreview'),
            save: t('save'),
            toolbar: t('toolbar'),
            placeholder: t('editorPlaceholder'),
            h1: t('toolbarH1'),
            h2: t('toolbarH2'),
            bold: t('toolbarBold'),
            italic: t('toolbarItalic'),
            bullet: t('toolbarBullet'),
            quote: t('toolbarQuote'),
            code: t('toolbarCode'),
            link: t('toolbarLink'),
            autosave: t('autosave'),
            undo: t('toolbarUndo'),
            redo: t('toolbarRedo'),
          }}
        />
      </div>
    </div>
  );
}
