'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import { useLocale, useTranslations } from 'next-intl';
import { Badge } from '@/components/ui/badge';
import { EmptyState } from '@/components/ui/empty-state';
import { SectionCard, SectionCardBody, SectionCardHeader } from '@/components/ui/section-card';
import { StatusBadge } from '@/components/ui/status-badge';
import { MemoComposer } from '@/components/memos/memo-composer';
import { useMemoPresence } from '@/components/memos/use-memo-presence';
import type { MemoDetailState, MemoReply } from '@/components/memos/memo-state';
import { formatLocaleDateTime } from '@/lib/i18n';

interface MemoDetailProps {
  memo: MemoDetailState;
  memberMap: Record<string, string>;
  projectId?: string;
  currentTeamMemberId?: string;
  currentTeamMemberName?: string;
  onReply: (memoId: string, content: string) => Promise<MemoReply | null>;
  onResolve: (memoId: string) => Promise<boolean>;
  onConvertToStory?: (memoId: string) => Promise<void>;
  onMemoChange?: (memo: MemoDetailState) => void;
}

interface ProjectDoc {
  id: string;
  title: string;
  slug: string;
  is_folder?: boolean;
}

function stringifyNames(entries: Array<{ name: string }>) {
  return entries.map((entry) => entry.name).join(', ');
}

function mergeReaderName(memo: MemoDetailState, readerId: string, readerName: string) {
  const readers = memo.readers ?? [];
  const existing = readers.find((reader) => reader.id === readerId);
  if (!existing) {
    return {
      ...memo,
      readers: [...readers, { id: readerId, name: readerName, read_at: new Date().toISOString() }],
    };
  }

  return {
    ...memo,
    readers: readers.map((reader) => (reader.id === readerId ? { ...reader, name: readerName } : reader)),
  };
}

const markdownClassName = 'prose prose-sm max-w-none text-foreground/90 [&_img]:mt-2 [&_img]:max-h-96 [&_img]:max-w-full [&_img]:rounded-xl [&_a]:break-all';

export function mergeReply(memo: MemoDetailState, reply: MemoReply) {
  const replies = memo.replies ?? [];
  if (replies.some((existing) => existing.id === reply.id)) {
    return memo;
  }

  const nextReplies = [...replies, reply];
  return {
    ...memo,
    replies: nextReplies,
    reply_count: nextReplies.length,
    latest_reply_at: reply.created_at,
  };
}

export function MemoDetail({
  memo,
  memberMap,
  projectId,
  currentTeamMemberId,
  currentTeamMemberName,
  onReply,
  onResolve,
  onConvertToStory,
  onMemoChange,
}: MemoDetailProps) {
  const locale = useLocale();
  const t = useTranslations('memos');
  const tc = useTranslations('common');
  const [memoState, setMemoState] = useState<MemoDetailState>(memo);
  const [replyContent, setReplyContent] = useState('');
  const [sending, setSending] = useState(false);
  const [availableDocs, setAvailableDocs] = useState<ProjectDoc[]>([]);
  const [docSearch, setDocSearch] = useState('');
  const [selectedDocId, setSelectedDocId] = useState('');
  const [linkingDoc, setLinkingDoc] = useState(false);
  const [linkError, setLinkError] = useState('');
  const [showCreateDoc, setShowCreateDoc] = useState(false);
  const [newDocTitle, setNewDocTitle] = useState('');
  const [creatingDoc, setCreatingDoc] = useState(false);
  const collaboration = useMemoPresence({
    memoId: memoState.id,
    currentTeamMemberId,
    currentTeamMemberName,
    enabled: Boolean(memoState.id && currentTeamMemberId),
  });

  const applyMemoState = useCallback((updater: (current: MemoDetailState) => MemoDetailState) => {
    setMemoState((current) => {
      const next = updater(current);
      onMemoChange?.(next);
      return next;
    });
  }, [onMemoChange]);

  useEffect(() => {
    setMemoState(memo);
  }, [memo]);

  useEffect(() => {
    setReplyContent('');
    setShowCreateDoc(false);
    setSelectedDocId('');
    setDocSearch('');
    setLinkError('');
    setNewDocTitle('');
  }, [memo.id]);

  useEffect(() => {
    if (!currentTeamMemberId) return;
    const readerName = currentTeamMemberName ?? memberMap[currentTeamMemberId] ?? currentTeamMemberId;
    const existingReader = memoState.readers?.find((reader) => reader.id === currentTeamMemberId);

    if (!existingReader) {
      applyMemoState((current) => mergeReaderName(current, currentTeamMemberId, readerName));
      void fetch(`/api/memos/${memoState.id}/read`, { method: 'PATCH' }).catch(() => {});
      return;
    }

    if (existingReader.name !== readerName) {
      applyMemoState((current) => mergeReaderName(current, currentTeamMemberId, readerName));
    }
  }, [applyMemoState, currentTeamMemberId, currentTeamMemberName, memberMap, memoState.id, memoState.readers]);

  useEffect(() => {
    let cancelled = false;
    const loadDocs = async () => {
      const resolvedProjectId = projectId ?? memoState.project_id;
      if (!resolvedProjectId) {
        setAvailableDocs([]);
        return;
      }
      const res = await fetch(`/api/docs?project_id=${resolvedProjectId}&view=tree`);
      if (!res.ok || cancelled) return;
      const json = await res.json();
      const docs = (json.data ?? []) as ProjectDoc[];
      if (!cancelled) {
        setAvailableDocs(docs.filter((doc) => !doc.is_folder));
      }
    };

    void loadDocs();
    return () => { cancelled = true; };
  }, [memoState.project_id, projectId]);

  const handleSubmitReply = useCallback(async () => {
    if (!replyContent.trim()) return;
    setSending(true);
    try {
      const reply = await onReply(memoState.id, replyContent.trim());
      if (reply) {
        applyMemoState((current) => mergeReply(current, reply));
        setReplyContent('');
      }
    } finally {
      setSending(false);
    }
  }, [applyMemoState, memoState.id, onReply, replyContent]);

  const handleResolve = useCallback(async () => {
    const resolved = await onResolve(memoState.id);
    if (!resolved) return;
    applyMemoState((current) => ({
      ...current,
      status: 'resolved',
      resolved_by: currentTeamMemberId ?? current.resolved_by ?? null,
      resolved_at: new Date().toISOString(),
    }));
  }, [applyMemoState, currentTeamMemberId, memoState.id, onResolve]);

  const filteredDocs = useMemo(() => {
    const query = docSearch.trim().toLowerCase();
    const linkedIds = new Set((memoState.linked_docs ?? []).map((doc) => doc.id));
    return availableDocs.filter((doc) => {
      if (linkedIds.has(doc.id)) return false;
      if (!query) return true;
      return doc.title.toLowerCase().includes(query) || doc.slug.toLowerCase().includes(query);
    });
  }, [availableDocs, docSearch, memoState.linked_docs]);

  const handleLinkExistingDoc = useCallback(async () => {
    if (!selectedDocId) return;
    setLinkingDoc(true);
    setLinkError('');
    try {
      const res = await fetch(`/api/memos/${memoState.id}/linked-docs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ doc_id: selectedDocId }),
      });
      if (!res.ok) {
        const json = await res.json().catch(() => null);
        throw new Error(json?.error?.message ?? t('linkDocFailed'));
      }
      const json = await res.json();
      if (json.data?.memo) {
        setMemoState(json.data.memo);
        onMemoChange?.(json.data.memo);
      }
      setSelectedDocId('');
    } catch (error) {
      setLinkError(error instanceof Error ? error.message : t('linkDocFailed'));
    } finally {
      setLinkingDoc(false);
    }
  }, [memoState.id, onMemoChange, selectedDocId, t]);

  const handleCreateDoc = useCallback(async () => {
    const title = newDocTitle.trim() || memoState.title || memoState.content.slice(0, 80) || t('createDocFromMemo');
    setCreatingDoc(true);
    setLinkError('');
    try {
      const res = await fetch(`/api/memos/${memoState.id}/linked-docs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, content: memoState.content, content_format: 'markdown' }),
      });
      if (!res.ok) {
        const json = await res.json().catch(() => null);
        throw new Error(json?.error?.message ?? t('createDocFailed'));
      }
      const json = await res.json();
      if (json.data?.memo) {
        setMemoState(json.data.memo);
        onMemoChange?.(json.data.memo);
      }
      if (json.data?.doc) {
        setAvailableDocs((prev) => [...prev, json.data.doc]);
      }
      setShowCreateDoc(false);
      setNewDocTitle('');
    } catch (error) {
      setLinkError(error instanceof Error ? error.message : t('createDocFailed'));
    } finally {
      setCreatingDoc(false);
    }
  }, [memoState.content, memoState.id, memoState.title, newDocTitle, onMemoChange, t]);

  useEffect(() => {
    const autoName = memoState.title || memoState.content.slice(0, 80);
    setNewDocTitle((current) => current || autoName);
  }, [memoState.content, memoState.title]);

  const getMemoTypeLabel = (memoType: string) => {
    const key = `type${memoType.charAt(0).toUpperCase()}${memoType.slice(1)}`;
    return t.has(key) ? t(key as 'typeMemo') : memoType;
  };

  const getMemoStatusLabel = (status: string) => {
    const key = `channel${status.charAt(0).toUpperCase()}${status.slice(1)}`;
    return t.has(key) ? t(key as 'channelOpen') : status;
  };

  const currentReaders = memoState.readers ?? [];
  const currentViewers = collaboration.viewers;
  const typingUsers = collaboration.typingUsers;

  return (
    <div className="flex h-full flex-col">
      <SectionCard className="rounded-none border-0 border-b">
        <SectionCardHeader className="space-y-3">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0 space-y-1.5">
              <h2 className="truncate text-lg font-semibold text-foreground">
                {memoState.title || memoState.content.slice(0, 60)}
              </h2>
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <span className="font-semibold text-foreground">
                  {memoState.created_by ? (memberMap[memoState.created_by] ?? tc('unknown')) : tc('deletedUser')}
                </span>
                {memoState.assigned_to ? (
                  <span className="text-muted-foreground">→ {memberMap[memoState.assigned_to] ?? tc('unknown')}</span>
                ) : null}
                <span className="text-muted-foreground">{formatLocaleDateTime(memoState.created_at, locale)}</span>
              </div>
              <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <StatusBadge status={memoState.status} label={getMemoStatusLabel(memoState.status)} />
                <Badge variant="outline">{getMemoTypeLabel(memoState.memo_type)}</Badge>
                {memoState.project_name ? <span>{memoState.project_name}</span> : null}
              </div>
            </div>
            <div className="flex gap-2">
              {onConvertToStory ? (
                <button onClick={() => onConvertToStory(memoState.id)} className="rounded-xl bg-muted px-3 py-2 text-xs font-medium text-foreground hover:bg-muted/80">
                  {t('convertToStory')}
                </button>
              ) : null}
              {memoState.status === 'open' ? (
                <button onClick={handleResolve} className="rounded-xl bg-emerald-600 px-3 py-2 text-xs font-medium text-white hover:bg-emerald-700">
                  {t('resolve')}
                </button>
              ) : null}
            </div>
          </div>
          <div className="flex flex-wrap gap-3 text-xs text-muted-foreground">
            {memoState.reply_count !== undefined ? <span>{t('replyCount')}: {memoState.reply_count}</span> : null}
            {memoState.latest_reply_at ? <span>{t('latestReply')}: {formatLocaleDateTime(memoState.latest_reply_at, locale)}</span> : null}
            {currentReaders.length ? <span>{t('readBy')}: {stringifyNames(currentReaders)}</span> : null}
          </div>
          <div className="flex flex-wrap gap-3 text-xs text-muted-foreground">
            {currentViewers.length ? <span>{t('currentViewers')}: {stringifyNames(currentViewers)}</span> : null}
            {typingUsers.length ? <span>{t('typingNow')}: {stringifyNames(typingUsers)}</span> : null}
          </div>
        </SectionCardHeader>
      </SectionCard>

      <div className="grid flex-1 gap-4 overflow-y-auto p-4 lg:grid-cols-[minmax(0,1.5fr)_320px]">
        <div className="space-y-4">
          <SectionCard>
            <SectionCardBody>
              <div className={markdownClassName}>
                <ReactMarkdown>{memoState.content}</ReactMarkdown>
              </div>
            </SectionCardBody>
          </SectionCard>

          <SectionCard>
            <SectionCardHeader>
              <div className="text-sm font-semibold">{t('replies')} {memoState.replies?.length ? `(${memoState.replies.length})` : ''}</div>
            </SectionCardHeader>
            <SectionCardBody className="space-y-3">
              {memoState.replies?.length ? memoState.replies.map((r) => (
                <div key={r.id} className="rounded-xl border border-border/60 bg-muted/30 p-3">
                  <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                    <span className="font-medium text-foreground">{r.created_by ? (memberMap[r.created_by] ?? tc('unknown')) : tc('deletedUser')}</span>
                    <span>{formatLocaleDateTime(r.created_at, locale)}</span>
                    {r.review_type !== 'comment' ? <Badge variant="secondary">{r.review_type}</Badge> : null}
                  </div>
                  <div className={markdownClassName}>
                    <ReactMarkdown>{r.content}</ReactMarkdown>
                  </div>
                </div>
              )) : <EmptyState title={t('noReplies')} description={t('replyPlaceholder')} />}
            </SectionCardBody>
          </SectionCard>
        </div>

        <div className="space-y-4">
          <SectionCard>
            <SectionCardHeader><div className="text-sm font-semibold">{t('timeline')}</div></SectionCardHeader>
            <SectionCardBody>
              {memoState.timeline?.length ? (
                <div className="space-y-3">
                  {memoState.timeline.map((item, idx) => (
                    <div key={`${item.label}-${idx}`} className="border-l border-border/60 pl-3">
                      <div className="text-sm font-medium text-foreground">{item.label}</div>
                      <div className="text-xs text-muted-foreground">{formatLocaleDateTime(item.at, locale)}{item.by ? ` · ${memberMap[item.by] ?? item.by}` : ''}</div>
                    </div>
                  ))}
                </div>
              ) : <p className="text-sm text-muted-foreground">{t('noTimelineEvents')}</p>}
            </SectionCardBody>
          </SectionCard>

          <SectionCard>
            <SectionCardHeader><div className="text-sm font-semibold">{t('linkedDocs')}</div></SectionCardHeader>
            <SectionCardBody>
              {memoState.linked_docs?.length ? (
                <div className="space-y-2">
                  {memoState.linked_docs.map((doc) => (
                    <div key={doc.id} className="rounded-xl border border-border/60 px-3 py-2 text-sm">
                      <div className="font-medium">{doc.slug ? <a href={`/docs?slug=${encodeURIComponent(doc.slug)}`} className="hover:underline">{doc.title}</a> : doc.title}</div>
                      {doc.slug ? <div className="text-xs text-muted-foreground">/{doc.slug}</div> : null}
                    </div>
                  ))}
                </div>
              ) : <p className="text-sm text-muted-foreground">{t('noLinkedDocs')}</p>}

              {projectId || memoState.project_id ? (
                <div className="mt-4 space-y-3 rounded-2xl border border-border/60 bg-muted/20 p-3">
                  <div className="flex items-center justify-between gap-2">
                    <div className="text-sm font-semibold text-foreground">{t('docLinkTools')}</div>
                    <button
                      type="button"
                      onClick={() => setShowCreateDoc((prev) => !prev)}
                      className="rounded-xl border border-input px-3 py-1.5 text-xs text-muted-foreground hover:bg-muted"
                    >
                      {showCreateDoc ? t('hideCreateDoc') : t('createDocFromMemo')}
                    </button>
                  </div>

                  <div className="space-y-2">
                    <input
                      type="text"
                      value={docSearch}
                      onChange={(event) => setDocSearch(event.target.value)}
                      placeholder={t('searchDocs')}
                      className="w-full rounded-xl border border-input px-3 py-2 text-sm focus:border-ring focus:outline-none"
                    />
                    <select
                      value={selectedDocId}
                      onChange={(event) => setSelectedDocId(event.target.value)}
                      className="w-full rounded-xl border border-input px-3 py-2 text-sm focus:border-ring focus:outline-none"
                    >
                      <option value="">{t('selectDocToLink')}</option>
                      {filteredDocs.map((doc) => (
                        <option key={doc.id} value={doc.id}>{doc.title} /{doc.slug}</option>
                      ))}
                    </select>
                    <button
                      type="button"
                      onClick={handleLinkExistingDoc}
                      disabled={!selectedDocId || linkingDoc}
                      className="w-full rounded-xl bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {linkingDoc ? t('linkingDoc') : t('linkSelectedDoc')}
                    </button>
                  </div>

                  {showCreateDoc ? (
                    <div className="space-y-2 rounded-2xl border border-border/60 bg-background p-3">
                      <input
                        type="text"
                        value={newDocTitle}
                        onChange={(event) => setNewDocTitle(event.target.value)}
                        placeholder={t('docTitlePlaceholder')}
                        className="w-full rounded-xl border border-input px-3 py-2 text-sm focus:border-ring focus:outline-none"
                      />
                      <button
                        type="button"
                        onClick={handleCreateDoc}
                        disabled={creatingDoc}
                        className="w-full rounded-xl bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        {creatingDoc ? t('creatingDoc') : t('createAndLinkDoc')}
                      </button>
                    </div>
                  ) : null}

                  {linkError ? <p className="text-xs text-red-600">{linkError}</p> : null}
                </div>
              ) : null}
            </SectionCardBody>
          </SectionCard>
        </div>
      </div>

      <div className="sticky bottom-0 border-t border-white/10 bg-[color:var(--operator-panel)] p-4">
        <MemoComposer
          collaboration={collaboration}
          value={replyContent}
          onChange={setReplyContent}
          onSubmit={handleSubmitReply}
          placeholder={t('replyPlaceholder')}
          submitLabel={t('send')}
          helperText={t('imagePasteHint')}
          rows={5}
          submitting={sending}
          memoId={memoState.id}
          currentTeamMemberId={currentTeamMemberId}
          currentTeamMemberName={currentTeamMemberName ?? (currentTeamMemberId ? memberMap[currentTeamMemberId] : undefined)}
        />
      </div>
    </div>
  );
}
