'use client';

import { useTranslations } from 'next-intl';
import { EmptyState } from '@/components/ui/empty-state';
import { Button } from '@/components/ui/button';
import type { MemoSummaryState } from './memo-state';

interface MemoFeedProps {
  memos: MemoSummaryState[];
  onSelectMemo: (memoId: string) => void;
  selectedMemoId: string | null;
  memberMap?: Record<string, string>;
  onNewMemo?: () => void;
}

/**
 * Message feed style memo list
 * Replaces traditional list view with conversation-style feed
 */
export function MemoFeed({ memos, onSelectMemo, selectedMemoId, memberMap = {}, onNewMemo }: MemoFeedProps) {
  const t = useTranslations('memos');

  if (memos.length === 0) {
    return (
      <div className="p-4">
        <EmptyState
          title={t('noMemos')}
          description={t('selectMemo')}
          action={onNewMemo ? (
            <Button
              type="button"
              size="sm"
              onClick={onNewMemo}
            >
              {t('newMemo')}
            </Button>
          ) : null}
          className="bg-background/70"
        />
      </div>
    );
  }

  return (
    <div className="flex flex-col divide-y divide-white/10">
      {memos.map((memo) => (
        <MemoFeedItem
          key={memo.id}
          memo={memo}
          isSelected={memo.id === selectedMemoId}
          onClick={() => onSelectMemo(memo.id)}
          memberMap={memberMap}
        />
      ))}
    </div>
  );
}

interface MemoFeedItemProps {
  memo: MemoSummaryState;
  isSelected: boolean;
  onClick: () => void;
  memberMap: Record<string, string>;
}

function MemoFeedItem({ memo, isSelected, onClick, memberMap }: MemoFeedItemProps) {
  const t = useTranslations('memos');
  const hasUnread = (memo.unread_count ?? 0) > 0;
  const senderName = memo.created_by ? (memberMap[memo.created_by] ?? memo.created_by) : '—';

  return (
    <button
      type="button"
      onClick={onClick}
      className={`
        flex w-full flex-col gap-1.5 px-4 py-3 text-left transition-colors
        hover:bg-white/5
        ${isSelected ? 'bg-[color:var(--operator-primary)]/14' : ''}
      `}
    >
      {/* Slack-style header: sender + date */}
      <div className="flex items-center justify-between gap-2">
        <span className={`truncate text-xs ${hasUnread ? 'font-bold text-[color:var(--operator-foreground)]' : 'font-semibold text-[color:var(--operator-foreground)]'}`}>
          {senderName}
        </span>
        <span className="shrink-0 text-[10px] text-[color:var(--operator-muted)]">
          {new Date(memo.created_at).toLocaleDateString()}
        </span>
      </div>

      {/* Title + content preview */}
      <div className="min-w-0">
        {memo.title && (
          <div className={`truncate text-sm ${hasUnread ? 'font-semibold' : ''} text-[color:var(--operator-foreground)]`}>
            {memo.title}
          </div>
        )}
        <div className="line-clamp-1 text-xs text-[color:var(--operator-muted)]">
          {memo.content}
        </div>
      </div>

      {/* Footer: reply count + unread badge */}
      {((memo.reply_count ?? 0) > 0 || hasUnread) && (
        <div className="flex items-center gap-2">
          {(memo.reply_count ?? 0) > 0 && (
            <span className="text-[10px] text-[color:var(--operator-muted)]">{t('repliesCountBadge', { count: memo.reply_count ?? 0 })}</span>
          )}
          {hasUnread && (
            <div className="flex h-4 w-4 items-center justify-center rounded-full bg-blue-500 text-[10px] text-white">
              {memo.unread_count}
            </div>
          )}
        </div>
      )}
    </button>
  );
}
