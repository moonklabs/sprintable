'use client';

import { useCallback, useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { DocEditor } from '@/components/docs/doc-editor';
import { useDocSync, type SaveStatus } from '@/components/docs/use-doc-sync';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import Link from 'next/link';
import { Check, Copy, Eye, Trash2 } from 'lucide-react';
import { useDocsLayout } from '../docs-context';
import { EntityDispatchPanel } from '@/components/dispatch/entity-dispatch-panel';

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

const SAVE_STATUS_CLASS: Partial<Record<SaveStatus, string>> = {
  saving: 'text-[color:var(--operator-muted)]',
  saved: 'text-emerald-500/70',
  unsaved: 'text-amber-500/70',
  error: 'text-rose-500',
  conflict: 'text-rose-500',
  'remote-changed': 'text-amber-500',
};

function SaveStatusIndicator({ status, t }: { status: SaveStatus; t: ReturnType<typeof useTranslations> }) {
  const map: Partial<Record<SaveStatus, string>> = {
    saving: t('statusSaving'),
    saved: t('statusSaved'),
    unsaved: t('statusUnsaved'),
    error: t('statusError'),
    conflict: t('statusConflict'),
    'remote-changed': t('statusRemoteChanged'),
  };
  const text = map[status] ?? null;
  if (!text) return null;
  return <span className={`shrink-0 text-xs ${SAVE_STATUS_CLASS[status] ?? ''}`}>{text}</span>;
}

export default function DocSlugPage() {
  const params = useParams();
  const slug = typeof params.slug === 'string' ? params.slug : '';
  const router = useRouter();
  const t = useTranslations('docs');

  const { projectId, setTree, pendingDocUpdate, clearPendingDocUpdate } = useDocsLayout();

  const [selectedDoc, setSelectedDoc] = useState<DocDetail | null>(null);
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [contentFormat, setContentFormat] = useState<'markdown' | 'html'>('markdown');
  const [autosave, setAutosave] = useState(true);
  const [mdCopied, setMdCopied] = useState(false);

  const handleDocSaved = useCallback((doc: DocDetail) => {
    setSelectedDoc(doc);
    setTree((prev) => prev.map((d) => (d.id === doc.id ? { ...d, title: doc.title } : d)));
  }, [setTree]);

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
    try {
      const res = await fetch(`/api/docs?project_id=${projectId}&slug=${slug}`);
      if (!res.ok) throw new Error('Failed to fetch doc');
      const { data } = await res.json();
      setSelectedDoc(data);
      setTitle(data.title);
      setContent(data.content);
      setContentFormat(data.content_format || 'markdown');
    } catch {
      setSelectedDoc(null);
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
    try {
      if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(content);
      }
    } catch { /* clipboard unavailable */ }
    setMdCopied(true);
    window.setTimeout(() => setMdCopied(false), 1600);
  }, [content]);

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

  if (!selectedDoc) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-sm text-[color:var(--operator-muted)]">{t('loading')}</p>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* Header */}
      <div className="flex-shrink-0 border-b border-border px-4 py-3 lg:px-6 lg:py-5">
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
            <Button asChild variant="ghost" size="sm" title={t('preview')}>
              <Link href={`/docs/${slug}/view`}>
                <Eye className="h-4 w-4" />
              </Link>
            </Button>
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

      {/* Dispatch */}
      {projectId && (
        <div className="flex-shrink-0 border-b border-border px-4 py-2 lg:px-6">
          <EntityDispatchPanel
            entityType="doc"
            entityId={selectedDoc.id}
            projectId={projectId}
            currentAssigneeId={selectedDoc.assignee_id}
            onAssigneePatched={(aid) => setSelectedDoc((prev) => prev ? { ...prev, assignee_id: aid } : prev)}
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
          }}
        />
      </div>
    </div>
  );
}
