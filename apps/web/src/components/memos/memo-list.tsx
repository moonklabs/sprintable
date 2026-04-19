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
          {/* Mobile (< lg): Slack conversation style — no badges */}
          <div className="lg:hidden">
            <div className="mb-1 flex items-center justify-between gap-2">
              <span className="truncate text-xs font-semibold text-foreground">
                {m.created_by ? (memberMap[m.created_by] ?? tc('unknown')) : tc('deletedUser')}
              </span>
              <span className="shrink-0 text-[10px] text-muted-foreground">{formatLocaleDateOnly(m.created_at, locale)}</span>
            </div>
            <p className="line-clamp-2 text-sm text-foreground">
              {m.title || m.content.slice(0, 120)}
            </p>
            {m.reply_count ? (
              <p className="mt-1 text-[10px] text-muted-foreground">{t('repliesCountBadge', { count: m.reply_count })}</p>
            ) : null}
          </div>

          {/* Desktop (lg+): full info — title + status + badges */}
          <div className="hidden lg:block">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0 flex-1 space-y-1">
                <p className="truncate text-sm font-semibold text-foreground">
                  {m.title || m.content.slice(0, 72)}
                </p>
                <p className="line-clamp-2 text-xs text-muted-foreground">
                  {m.project_name ? `${m.project_name} · ` : ''}{m.content.slice(0, 120)}
                </p>
              </div>
              <StatusBadge status={m.status} label={getMemoStatusLabel(m.status)} />
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <Badge variant="outline">{getMemoTypeLabel(m.memo_type)}</Badge>
              {m.reply_count ? <Badge variant="secondary">{t('repliesCountBadge', { count: m.reply_count })}</Badge> : null}
              <span>{m.created_by ? (memberMap[m.created_by] ?? tc('unknown')) : tc('deletedUser')}</span>
              {m.assigned_to ? (
                <>
                  <span>→</span>
                  <span>{memberMap[m.assigned_to] || tc('unknown')}</span>
                </>
              ) : null}
              <span className="ml-auto">{formatLocaleDateOnly(m.created_at, locale)}</span>
            </div>
          </div>
        </button>
      ))}
    </div>
  );
}
