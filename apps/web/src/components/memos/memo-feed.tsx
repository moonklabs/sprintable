'use client';

import { useTranslations } from 'next-intl';
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
      <div className="flex flex-col items-center justify-center gap-3 py-12 text-center">
        <p className="text-sm text-[color:var(--operator-muted)]">{t('noMemos')}</p>
        {onNewMemo ? (
          <button
            type="button"
            onClick={onNewMemo}
            className="rounded-xl bg-[color:var(--operator-primary)]/20 px-4 py-2 text-xs font-medium text-[color:var(--operator-primary-soft)] hover:bg-[color:var(--operator-primary)]/30"
          >
            {t('newMemo')}
          </button>
        ) : null}
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
            <span className="text-[10px] text-[color:var(--operator-muted)]">{memo.reply_count === 1 ? '1 reply' : `${memo.reply_count} replies`}</span>
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
