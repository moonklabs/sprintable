'use client';

import type React from 'react';
import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { StatusBadge } from '@/components/ui/status-badge';
import { Textarea } from '@/components/ui/textarea';
import type { MemoDetailState } from './memo-state';

interface MemoThreadProps {
  memo: MemoDetailState;
  currentUserId: string;
  onReply: (content: string) => Promise<void>;
  onResolve: () => Promise<void>;
  memberMap?: Record<string, string>;
}

/**
 * Thread-based conversation view for memo
 * Replaces traditional detail panel with messaging UX
 */
const REPLY_COLLAPSE_THRESHOLD = 3;

export function MemoThread({ memo, currentUserId, onReply, onResolve, memberMap = {} }: MemoThreadProps) {
  const t = useTranslations('memos');
  const tc = useTranslations('common');
  const [replyContent, setReplyContent] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [repliesExpanded, setRepliesExpanded] = useState(false);

  const allReplies = memo.replies ?? [];
  const hiddenCount = Math.max(0, allReplies.length - REPLY_COLLAPSE_THRESHOLD);
  const visibleReplies = repliesExpanded || hiddenCount === 0
    ? allReplies
    : allReplies.slice(allReplies.length - REPLY_COLLAPSE_THRESHOLD);

  const senderName = memo.created_by ? (memberMap[memo.created_by] ?? tc('unknown')) : tc('deletedUser');
  const assigneeName = memo.assigned_to ? (memberMap[memo.assigned_to] ?? tc('unknown')) : null;
  const memoTypeLabel = memo.memo_type
    ? (() => {
        const key = `type${memo.memo_type.charAt(0).toUpperCase()}${memo.memo_type.slice(1)}`;
        return t.has(key) ? t(key as 'typeMemo') : memo.memo_type;
      })()
    : t('typeMemo');

  const handleSubmitReply = async () => {
    if (!replyContent.trim() || isSubmitting) return;

    setIsSubmitting(true);
    try {
      await onReply(replyContent.trim());
      setReplyContent('');
    } catch (error) {
      console.error('Failed to submit reply:', error);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void handleSubmitReply();
    }
  };

  return (
    <div className="flex h-full flex-col">
      {/* Thread header */}
      <div className="flex-shrink-0 border-b border-white/10 px-4 py-3 lg:px-5">
        <div className="mx-auto flex w-full max-w-4xl items-start justify-between gap-3">
          <div className="min-w-0 flex-1 space-y-1.5">
            {memo.title && (
              <h2 className="truncate text-lg font-semibold text-[color:var(--operator-foreground)]">
                {memo.title}
              </h2>
            )}
            <div className="flex flex-wrap items-center gap-1.5">
              <Badge variant="outline">{memoTypeLabel}</Badge>
              <StatusBadge status={memo.status} />
            </div>
            {/* Slack-style: sender → assignee + date */}
            <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
              <span className="font-semibold text-[color:var(--operator-foreground)]">{senderName}</span>
              {assigneeName ? (
                <span className="text-[color:var(--operator-muted)]">→ {assigneeName}</span>
              ) : null}
              <span className="text-[color:var(--operator-muted)]">{new Date(memo.created_at).toLocaleString()}</span>
            </div>
          </div>
          {memo.status === 'open' && (
            <Button variant="outline" size="sm" onClick={onResolve}>
              {t('resolve')}
            </Button>
          )}
        </div>
      </div>

      {/* Thread messages */}
      <div className="flex-1 overflow-y-auto bg-[color:var(--operator-surface-soft)]/20 px-4 py-3 lg:px-5">
        <div className="mx-auto w-full max-w-4xl space-y-3">
          {/* Original message */}
          <ThreadMessage
            content={memo.content}
            authorId={memo.created_by ?? null}
            timestamp={memo.created_at}
            isCurrentUser={memo.created_by === currentUserId}
            memberMap={memberMap}
          />

          {/* Replies — collapse when > 3 */}
          {hiddenCount > 0 && (
            <button
              type="button"
              onClick={() => setRepliesExpanded((v) => !v)}
              className="w-full rounded-xl border border-white/8 bg-white/4 py-1.5 text-center text-[11px] font-medium text-[color:var(--operator-muted)] transition hover:bg-white/8 hover:text-[color:var(--operator-foreground)]"
            >
              {repliesExpanded
                ? t('collapseReplies')
                : t('expandReplies', { count: hiddenCount })}
            </button>
          )}
          {visibleReplies.map((reply) => (
            <ThreadMessage
              key={reply.id}
              content={reply.content}
              authorId={reply.created_by}
              timestamp={reply.created_at}
              isCurrentUser={reply.created_by === currentUserId}
              reviewType={reply.review_type}
              memberMap={memberMap}
            />
          ))}
        </div>
      </div>

      {/* Reply input */}
      {memo.status === 'open' && (
        <div className="flex-shrink-0 border-t border-white/10 bg-background px-4 py-3 lg:px-5">
          <div className="mx-auto flex w-full max-w-4xl gap-2">
            <Textarea
              value={replyContent}
              onChange={(e) => setReplyContent(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={t('replyPlaceholder')}
              className="flex-1 min-h-[72px] resize-none rounded-xl bg-background"
              disabled={isSubmitting}
            />
            <Button
              onClick={() => void handleSubmitReply()}
              disabled={!replyContent.trim() || isSubmitting}
              size="sm"
              className="self-end"
            >
              {isSubmitting ? t('sending') : t('send')}
            </Button>
          </div>
          <div className="mx-auto mt-1.5 w-full max-w-4xl text-[11px] text-[color:var(--operator-muted)]">
            {t('replyHint')}
          </div>
        </div>
      )}
    </div>
  );
}

interface ThreadMessageProps {
  content: string;
  authorId?: string | null;
  timestamp: string;
  isCurrentUser: boolean;
  reviewType?: string;
  memberMap: Record<string, string>;
}

function renderWithMentions(text: string, isCurrentUser: boolean): React.ReactNode {
  const parts = text.split(/(@[\w가-힣]+)/g);
  return parts.map((part, i) => {
    if (/^@[\w가-힣]+$/.test(part)) {
      return (
        <span key={i} className={`font-semibold ${isCurrentUser ? 'text-blue-200' : 'text-[color:var(--operator-primary)]'}`}>
          {part}
        </span>
      );
    }
    return part;
  });
}

function ThreadMessage({ content, authorId, timestamp, isCurrentUser, reviewType, memberMap }: ThreadMessageProps) {
  const authorName = authorId ? (memberMap[authorId] ?? authorId) : '—';

  return (
    <div className={`flex ${isCurrentUser ? 'justify-end' : 'justify-start'}`}>
      <div
        className={`
          max-w-[86%] rounded-xl px-4 py-2.5 shadow-sm lg:max-w-[64%]
          ${isCurrentUser ? 'bg-blue-600 text-white' : 'border border-white/8 bg-background text-[color:var(--operator-foreground)]'}
          ${reviewType === 'approve' ? 'border-2 border-green-500' : ''}
          ${reviewType === 'request_changes' ? 'border-2 border-red-500' : ''}
        `}
      >
        {/* Author name above message */}
        {!isCurrentUser && (
          <div className="mb-1 text-[11px] font-semibold text-[color:var(--operator-foreground)]">
            {authorName}
          </div>
        )}
        <div className="whitespace-pre-wrap break-words text-[14px] leading-6">
          {renderWithMentions(content, isCurrentUser)}
        </div>
        <div className={`mt-1.5 text-[11px] ${isCurrentUser ? 'text-blue-200' : 'text-[color:var(--operator-muted)]'}`}>
          {new Date(timestamp).toLocaleTimeString()}
        </div>
      </div>
    </div>
  );
}
