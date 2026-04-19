'use client';

import { Badge } from '@/components/ui/badge';
import { EmptyState } from '@/components/ui/empty-state';
import { StatusBadge } from '@/components/ui/status-badge';
import { cn } from '@/lib/utils';
import { useLocale, useTranslations } from 'next-intl';
import { formatLocaleDateOnly } from '@/lib/i18n';

interface Memo {
  id: string;
  title: string | null;
  content: string;
  status: string;
  memo_type: string;
  created_by: string;
  assigned_to: string | null;
  created_at: string;
  reply_count?: number;
  latest_reply_at?: string | null;
  project_name?: string | null;
}

interface MemoListProps {
  memos: Memo[];
  memberMap: Record<string, string>;
  onSelect: (memo: Memo) => void;
  selectedId?: string;
}

export function MemoList({ memos, memberMap, onSelect, selectedId }: MemoListProps) {
  const locale = useLocale();
  const t = useTranslations('memos');
  const tc = useTranslations('common');

  const getMemoTypeLabel = (memoType: string) => {
    const key = `type${memoType.charAt(0).toUpperCase()}${memoType.slice(1)}`;
    return t.has(key) ? t(key as 'typeMemo') : memoType;
  };

  const getMemoStatusLabel = (status: string) => {
    const key = `channel${status.charAt(0).toUpperCase()}${status.slice(1)}`;
    return t.has(key) ? t(key as 'channelOpen') : status;
  };

  if (memos.length === 0) {
    return (
      <EmptyState
        title={t('noMemos')}
        description={t('selectMemo')}
      />
    );
  }

  return (
    <div className="divide-y divide-border/70">
      {memos.map((m) => (
        <button
          key={m.id}
          onClick={() => onSelect(m)}
          className={cn(
            'w-full px-4 py-3 text-left transition hover:bg-muted/60',
            selectedId === m.id && 'bg-primary/5',
          )}
        >
          {/* Slack-style: sender + date header */}
          <div className="mb-1 flex items-center justify-between gap-2">
            <div className="flex min-w-0 items-center gap-1.5">
              <span className="truncate text-xs font-semibold text-foreground">
                {m.created_by ? (memberMap[m.created_by] ?? tc('unknown')) : tc('deletedUser')}
              </span>
              {m.assigned_to ? (
                <span className="shrink-0 text-xs text-muted-foreground">→ {memberMap[m.assigned_to] || tc('unknown')}</span>
              ) : null}
              <Badge variant="outline" className="shrink-0 text-[10px]">{getMemoTypeLabel(m.memo_type)}</Badge>
            </div>
            <span className="shrink-0 text-[10px] text-muted-foreground">{formatLocaleDateOnly(m.created_at, locale)}</span>
          </div>

          {/* Title / content preview */}
          <p className="truncate text-sm font-medium text-foreground">
            {m.title || m.content.slice(0, 72)}
          </p>
          {m.title && (
            <p className="mt-0.5 line-clamp-1 text-xs text-muted-foreground">
              {m.project_name ? `${m.project_name} · ` : ''}{m.content.slice(0, 80)}
            </p>
          )}

          {/* Compact footer: reply count + status */}
          <div className="mt-1.5 flex items-center justify-between gap-2">
            <span className="text-[10px] text-muted-foreground">
              {m.reply_count ? t('repliesCountBadge', { count: m.reply_count }) : ''}
            </span>
            <StatusBadge status={m.status} label={getMemoStatusLabel(m.status)} />
          </div>
        </button>
      ))}
    </div>
  );
}
