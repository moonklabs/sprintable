'use client';

import type React from 'react';
import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeSanitize from 'rehype-sanitize';
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
  const [isResolving, setIsResolving] = useState(false);
  const [repliesExpanded, setRepliesExpanded] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const allRepliesCount = (memo.replies ?? []).length;

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [allRepliesCount]);

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

  const handleResolve = async () => {
    if (isResolving) return;
    setIsResolving(true);
    try {
      await onResolve();
    } catch (error) {
      console.error('Failed to resolve memo:', error);
    } finally {
      setIsResolving(false);
    }
  };

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
            <Button variant="outline" size="sm" onClick={() => void handleResolve()} disabled={isResolving}>
              {isResolving ? t('resolving') : t('resolve')}
            </Button>
          )}
        </div>
      </div>

      {/* Thread messages */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto bg-[color:var(--operator-surface-soft)]/20 px-4 py-3 lg:px-5">
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

function MarkdownContent({ content, isCurrentUser }: { content: string; isCurrentUser: boolean }) {
  const text = isCurrentUser ? 'text-primary-foreground' : 'text-[color:var(--operator-foreground)]';
  const muted = isCurrentUser ? 'text-primary-foreground/70' : 'text-[color:var(--operator-muted)]';
  const codeBg = isCurrentUser ? 'bg-primary-foreground/10 text-primary-foreground' : 'bg-muted text-[color:var(--operator-foreground)]';
  const border = isCurrentUser ? 'border-primary-foreground/30' : 'border-border';

  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      rehypePlugins={[rehypeSanitize]}
      components={{
        p: ({ children }) => <p className={`mb-2 break-words text-[14px] leading-6 last:mb-0 ${text}`}>{children}</p>,
        h1: ({ children }) => <h1 className={`mb-2 text-lg font-bold ${text}`}>{children}</h1>,
        h2: ({ children }) => <h2 className={`mb-2 text-base font-bold ${text}`}>{children}</h2>,
        h3: ({ children }) => <h3 className={`mb-1.5 text-sm font-bold ${text}`}>{children}</h3>,
        ul: ({ children }) => <ul className={`mb-2 ml-4 list-disc space-y-0.5 ${text}`}>{children}</ul>,
        ol: ({ children }) => <ol className={`mb-2 ml-4 list-decimal space-y-0.5 ${text}`}>{children}</ol>,
        li: ({ children }) => <li className={`text-[14px] leading-6 ${text}`}>{children}</li>,
        pre: ({ children }) => <pre className={`mb-2 overflow-x-auto rounded-lg p-3 text-[13px] ${codeBg}`}>{children}</pre>,
        code: ({ children }) => <code className={`rounded px-1 py-0.5 font-mono text-[13px] ${codeBg}`}>{children}</code>,
        blockquote: ({ children }) => <blockquote className={`mb-2 border-l-2 pl-3 ${border} ${muted}`}>{children}</blockquote>,
        a: ({ href, children }) => <a href={href} target="_blank" rel="noopener noreferrer" className="underline underline-offset-2">{children}</a>,
        strong: ({ children }) => <strong className={`font-semibold ${text}`}>{children}</strong>,
        em: ({ children }) => <em className={`italic ${text}`}>{children}</em>,
        hr: () => <hr className={`my-2 ${border}`} />,
      }}
    >
      {content}
    </ReactMarkdown>
  );
}

function ThreadMessage({ content, authorId, timestamp, isCurrentUser, reviewType, memberMap }: ThreadMessageProps) {
  const authorName = authorId ? (memberMap[authorId] ?? authorId) : '—';

  return (
    <div className={`flex ${isCurrentUser ? 'justify-end' : 'justify-start'}`}>
      <div
        className={`
          max-w-[86%] rounded-xl px-4 py-2.5 shadow-sm lg:max-w-[64%]
          ${isCurrentUser ? 'bg-primary text-primary-foreground' : 'border border-white/8 bg-background text-[color:var(--operator-foreground)]'}
          ${reviewType === 'approve' ? 'border-2 border-green-500' : ''}
          ${reviewType === 'request_changes' ? 'border-2 border-red-500' : ''}
        `}
      >
        {!isCurrentUser && (
          <div className="mb-1 text-[11px] font-semibold text-[color:var(--operator-foreground)]">
            {authorName}
          </div>
        )}
        <MarkdownContent content={content} isCurrentUser={isCurrentUser} />
        <div className={`mt-1.5 text-[11px] ${isCurrentUser ? 'text-primary-foreground/70' : 'text-[color:var(--operator-muted)]'}`}>
          {new Date(timestamp).toLocaleTimeString()}
        </div>
      </div>
    </div>
  );
}
