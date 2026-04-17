'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import type { MemoSummaryState } from './memo-state';

interface MemoFeedProps {
  memos: MemoSummaryState[];
  onSelectMemo: (memoId: string) => void;
  selectedMemoId: string | null;
}

/**
 * Message feed style memo list
 * Replaces traditional list view with conversation-style feed
 */
export function MemoFeed({ memos, onSelectMemo, selectedMemoId }: MemoFeedProps) {
  const t = useTranslations('memos');

  if (memos.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-center">
        <p className="text-sm text-gray-400">{t('noMemos')}</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col divide-y divide-gray-800">
      {memos.map((memo) => (
        <MemoFeedItem
          key={memo.id}
          memo={memo}
          isSelected={memo.id === selectedMemoId}
          onClick={() => onSelectMemo(memo.id)}
        />
      ))}
    </div>
  );
}

interface MemoFeedItemProps {
  memo: MemoSummaryState;
  isSelected: boolean;
  onClick: () => void;
}

function MemoFeedItem({ memo, isSelected, onClick }: MemoFeedItemProps) {
  const hasUnread = (memo.unread_count ?? 0) > 0;

  return (
    <button
      type="button"
      onClick={onClick}
      className={`
        flex w-full flex-col gap-2 px-4 py-3 text-left transition-colors
        hover:bg-gray-800/50
        ${isSelected ? 'bg-gray-800' : ''}
        ${hasUnread ? 'font-semibold' : ''}
      `}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1 min-w-0">
          {memo.title && (
            <div className="text-sm text-gray-100 truncate">
              {memo.title}
            </div>
          )}
          <div className="text-sm text-gray-400 line-clamp-2 mt-1">
            {memo.content}
          </div>
        </div>
        {hasUnread && (
          <div className="flex-shrink-0">
            <div className="flex h-5 w-5 items-center justify-center rounded-full bg-blue-500 text-xs text-white">
              {memo.unread_count}
            </div>
          </div>
        )}
      </div>
      <div className="flex items-center gap-2 text-xs text-gray-500">
        <span>{new Date(memo.created_at).toLocaleDateString()}</span>
        {(memo.reply_count ?? 0) > 0 && (
          <>
            <span>•</span>
            <span>{memo.reply_count} replies</span>
          </>
        )}
      </div>
    </button>
  );
}
