'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { DocEditor } from '@/components/docs/doc-editor';
import { DocGateSection } from '@/components/docs/doc-gate-section';
import { DocUrlChip } from '@/components/docs/doc-url-chip';
import { DocUrlDialog, type SlugSubmitResult } from '@/components/docs/doc-url-dialog';
import { slugifyDocTitle, isUntitledSlug } from '@/components/docs/lib/doc-slug';
import { useDocSync, unwrapDocResponse, type SaveStatus } from '@/components/docs/use-doc-sync';
import { htmlToMarkdown } from '@/components/docs/lib/content-converter';
import Link from 'next/link';
import { Check, Copy, Eye, Link2, Loader2, MoreHorizontal, Share2, Trash2, XCircle } from 'lucide-react';
import { DocShareDialog } from '@/components/docs/doc-share-dialog';
import { DocSyncBanner } from '@/components/docs/doc-sync-banner';
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
  slug_locked?: boolean;
  canonical_slug?: string;
  // E-DG S22/S28: doc decision lifecycle status(draft|pending|confirmed|denied·기본 draft) + cross-doc 대체 포인터(S28·additive).
  status?: string;
  superseded_by?: string | null;
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
  // conflict / remote-changed are surfaced by DocSyncBanner (the off-ramp), not this
  // status chip — keeping a chip here too would double-surface and re-expose the
  // dead-end onAction. (fc4d4264 FIX-4)
  return null;
}

export default function DocSlugPage() {
  const params = useParams();
  const slug = typeof params.slug === 'string' ? params.slug : '';
  const router = useRouter();
  const t = useTranslations('docs');
  const tc = useTranslations('common');
  const ts = useTranslations('share');
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
  const [slugLocked, setSlugLocked] = useState(false);
  const [urlDialogOpen, setUrlDialogOpen] = useState(false);
  const [shareDialogOpen, setShareDialogOpen] = useState(false);
  // §3-2 슬림 헤더 메타: 수정 이력 N(작성자는 created_by/memberMap 부재로 드롭·PO 보수안). DocGateSection도
  // revision을 fetch하나 헤더 메타용으로 경량 count만 별도 조회(공유 리프트는 S28 refactor라 follow-up).
  const [revisionCount, setRevisionCount] = useState<number | null>(null);
  const docId = selectedDoc?.id ?? null;
  useEffect(() => {
    if (!docId) { setRevisionCount(null); return; }
    let alive = true;
    void fetch(`/api/docs/${docId}/revisions`)
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null)
      .then((json) => {
        if (!alive) return;
        const rows = (json?.data ?? json) as unknown[];
        setRevisionCount(Array.isArray(rows) ? rows.length : null);
      });
    return () => { alive = false; };
  }, [docId]);

  const handleDocSaved = useCallback((doc: DocDetail) => {
    setSelectedDoc(doc);
    setTree((prev) => prev.map((d) => (d.id === doc.id ? { ...d, title: doc.title, slug: doc.slug } : d)));
    if (typeof doc.slug_locked === 'boolean') setSlugLocked(doc.slug_locked);
    // Slug auto-derived / canonicalized server-side → move the URL to the canonical slug.
    if (doc.slug && doc.slug !== slug) {
      router.replace(`/docs/${doc.slug}`);
    }
  }, [setTree, slug, router]);

  const handleTitleChange = useCallback((value: string) => {
    setTitle(value);
    setSelectedDoc((prev) => (prev ? { ...prev, title: value } : null));
    setTree((prev) => prev.map((d) => (d.id === selectedDoc?.id ? { ...d, title: value } : d)));
  }, [selectedDoc?.id, setTree]);

  // AC1: while a new doc still carries its `untitled-<ts>` slug and the user has not
  // manually locked it, derive the slug from the title and send it in the same save as
  // the title. The BE silently de-duplicates with a `-N` suffix (auto path never 422s)
  // and returns the canonical slug, which handleDocSaved moves the URL to. An empty
  // derivation (emoji/symbols only) skips the slug entirely so the doc keeps untitled.
  const shouldAutoDeriveSlug = selectedDoc !== null && !slugLocked && isUntitledSlug(selectedDoc.slug);
  const derivedSlug = shouldAutoDeriveSlug ? slugifyDocTitle(title) : '';

  const { status: saveStatus, isDirty, save, clearSyncAlerts } = useDocSync<DocDetail>({
    docId: selectedDoc?.id ?? null,
    savePayload: derivedSlug
      ? { title, content, content_format: contentFormat, slug: derivedSlug, slug_locked: false }
      : { title, content, content_format: contentFormat },
    serverUpdatedAt: selectedDoc?.updated_at ?? null,
    editing: selectedDoc !== null,
    autosave,
    onSaved: handleDocSaved,
  });

  const fetchDoc = useCallback(async () => {
    if (!projectId || !slug) return;
    setDocLoading(true);
    try {
      // AC3 (fc4d4264): never serve the doc body from HTTP/bf cache — a stale load
      // re-seeds the editor with an outdated baseline and can re-trigger an overwrite.
      const res = await fetch(`/api/docs?project_id=${projectId}&slug=${slug}`, { cache: 'no-store' });
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
      setSlugLocked(data.slug_locked ?? false);
      // AC3: the request resolved via an old/alias slug → canonicalize the URL so
      // bookmarks and internal links settle on the live address (BE sends canonical_slug).
      const canonical = data.canonical_slug ?? data.slug;
      if (canonical && canonical !== slug) router.replace(`/docs/${canonical}`);
    } catch {
      setSelectedDoc(null);
    } finally {
      setDocLoading(false);
    }
  }, [projectId, slug, router]);

  useEffect(() => { void fetchDoc(); }, [fetchDoc]);

  // FIX-4 off-ramp (fc4d4264): resolve a conflict / remote-changed dead-end.
  // Pull re-fetches the live doc (fetchDoc is no-store, AC-F4-7) → the serverUpdatedAt
  // effect in useDocSync realigns the baseline + clears the latch; clearSyncAlerts is
  // the explicit belt-and-suspenders so the banner dismisses immediately.
  const handlePull = useCallback(async () => {
    await fetchDoc();
    clearSyncAlerts('saved');
  }, [fetchDoc, clearSyncAlerts]);

  // Overwrite is the only force path — the banner confirms before calling this, and
  // autosave/retry never force (FIX-2 invariant).
  const handleOverwrite = useCallback(() => {
    void save({ force: true });
  }, [save]);

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

  // AC2: explicit slug edit. Locks the slug (slug_locked: true) so auto-derivation
  // stops, and surfaces BE conflicts (409 → suggested -N) / format errors (422).
  const handleSubmitSlug = useCallback(async (newSlug: string): Promise<SlugSubmitResult> => {
    if (!selectedDoc) return { ok: false, code: 'invalid' };
    try {
      const res = await fetch(`/api/docs/${selectedDoc.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slug: newSlug, slug_locked: true }),
      });
      if (res.status === 409) {
        const body = await res.json().catch(() => null) as { error?: { suggestion?: string } } | null;
        return { ok: false, code: 'taken', suggestion: body?.error?.suggestion };
      }
      if (res.status === 422) return { ok: false, code: 'invalid' };
      if (!res.ok) return { ok: false, code: 'invalid' };
      // Same raw-proxy envelope class as the autosave path: docs PATCH is a raw
      // proxyToFastapi passthrough, so the body is the bare DocResponse — reading
      // `json.data` yielded undefined → BE-success slug edits surfaced as 'invalid'
      // and the derive nudge no-op'd (live since #1374). Reuse unwrapDocResponse.
      const { doc: data } = unwrapDocResponse<DocDetail>(await res.json());
      handleDocSaved(data);
      return { ok: true };
    } catch {
      return { ok: false, code: 'invalid' };
    }
  }, [selectedDoc, handleDocSaved]);

  // 권고1 (가디언): one-click derive for docs that have a title but still carry a
  // stale untitled-* slug (created before this feature). Auto-derive (AC1) only
  // fires on a title edit, so this nudge is the affordance that targets the
  // "untitled 잔존" report directly. Auto path (slug_locked:false) → BE silently de-dupes.
  const handleDeriveFromTitle = useCallback(async () => {
    if (!selectedDoc) return;
    const derived = slugifyDocTitle(title);
    if (!derived) return;
    try {
      const res = await fetch(`/api/docs/${selectedDoc.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slug: derived, slug_locked: false }),
      });
      if (res.ok) {
        // Raw-proxy envelope class (see handleSubmitSlug) — un-envelope the bare DocResponse.
        const { doc: data } = unwrapDocResponse<DocDetail>(await res.json());
        handleDocSaved(data);
      }
    } catch { /* derive failed — doc keeps its untitled slug */ }
  }, [selectedDoc, title, handleDocSaved]);

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
      <button
        type="button"
        onClick={() => setShareDialogOpen(true)}
        title={ts('share')}
        aria-label={ts('share')}
        className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
      >
        <Share2 className="h-4 w-4" />
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
              <DropdownMenuItem onClick={() => setUrlDialogOpen(true)}>
                <Link2 className="mr-2 h-4 w-4" />
                {t('editUrl')}
              </DropdownMenuItem>
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

      {/* S28: doc decision gate(검토 상태·반려 사유·재상신 CTA·revision 이력). 비-gated/이력없음은 self-hide. */}
      {selectedDoc.doc_type !== 'sprint_report' ? (
        <div className="flex-shrink-0 px-4 pt-3 lg:px-6">
          <DocGateSection docId={selectedDoc.id} status={selectedDoc.status} onTransitioned={fetchDoc} />
        </div>
      ) : null}

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
          metaSlot={
            <>
              {revisionCount != null ? (
                <>
                  <span className="tabular-nums">{t('docMetaRevisions', { count: revisionCount })}</span>
                  {selectedDoc.updated_at ? <span aria-hidden> · </span> : null}
                </>
              ) : null}
              {selectedDoc.updated_at ? (
                <span className="tabular-nums">{new Date(selectedDoc.updated_at).toLocaleString()}</span>
              ) : null}
            </>
          }
          urlSlot={
            <DocUrlChip
              slug={selectedDoc.slug}
              onEdit={selectedDoc.doc_type !== 'sprint_report' ? () => setUrlDialogOpen(true) : undefined}
              onDeriveFromTitle={selectedDoc.doc_type !== 'sprint_report' && slugifyDocTitle(title) ? handleDeriveFromTitle : undefined}
              labels={{ editUrl: t('editUrl'), slugNudge: t('slugNudge') }}
            />
          }
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
          syncBanner={
            saveStatus === 'conflict' || saveStatus === 'remote-changed' ? (
              <DocSyncBanner
                status={saveStatus}
                isDirty={isDirty}
                onPull={handlePull}
                onOverwrite={handleOverwrite}
                onDismiss={() => clearSyncAlerts(isDirty ? 'unsaved' : 'idle')}
                labels={{
                  title: saveStatus === 'conflict' ? t('statusConflict') : t('statusRemoteChanged'),
                  pull: t('conflictReload'),
                  overwrite: t('conflictOverwrite'),
                  keepEditing: t('syncKeepEditing'),
                  discardWarning: t('syncDiscardWarning'),
                  overwriteConfirm: t('syncOverwriteConfirm'),
                }}
              />
            ) : null
          }
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

      <DocUrlDialog
        open={urlDialogOpen}
        onClose={() => setUrlDialogOpen(false)}
        currentSlug={selectedDoc.slug}
        title={title}
        onSubmit={handleSubmitSlug}
        labels={{
          editUrl: t('editUrl'),
          urlDialogDesc: t('urlDialogDesc'),
          deriveFromTitle: t('deriveFromTitle'),
          aliasNote: t('aliasNote'),
          slugTaken: t('slugTaken'),
          slugInvalid: t('slugInvalid'),
          save: t('save'),
          cancel: tc('cancel'),
        }}
      />

      <DocShareDialog
        open={shareDialogOpen}
        onClose={() => setShareDialogOpen(false)}
        docId={selectedDoc.id}
        labels={{
          share: ts('share'),
          shareToWeb: ts('shareToWeb'),
          shareToWebDesc: ts('shareToWebDesc'),
          copyLink: ts('copyLink'),
          linkCopied: ts('linkCopied'),
          stopSharing: ts('stopSharing'),
          regenerateLink: ts('regenerateLink'),
          shareSingleDocNote: ts('shareSingleDocNote'),
        }}
      />
    </div>
  );
}
