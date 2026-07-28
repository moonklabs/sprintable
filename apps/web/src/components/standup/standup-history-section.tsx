'use client';

import { useCallback, useEffect, useState, startTransition } from 'react';
import { ClipboardList } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { parseCursorMeta } from '@/lib/pagination';

interface HistoryEntry {
  id: string;
  date: string;
  author_id: string;
  done: string | null;
  plan: string | null;
  blockers: string | null;
}

interface Props {
  projectId: string;
  memberNameById?: Record<string, string>;
}

export function StandupHistorySection({ projectId, memberNameById = {} }: Props) {
  const t = useTranslations('standup');
  const tCommon = useTranslations('common');
  const [entries, setEntries] = useState<HistoryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  // story #2248 — story-detail-panel.tsx의 활동/댓글 「더보기」 자리를 그대로 본뜬다(발명 금지).
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);

  useEffect(() => {
    if (!projectId) return;
    startTransition(() => setLoading(true));
    fetch(`/api/standup/history?project_id=${projectId}&limit=20`)
      .then((r) => r.json())
      .then((json) => {
        if (json?.data && Array.isArray(json.data)) setEntries(json.data);
        setNextCursor(parseCursorMeta(json.meta, 'standup-history-section').nextCursor);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [projectId]);

  const handleLoadMore = useCallback(async () => {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const res = await fetch(`/api/standup/history?project_id=${projectId}&limit=20&cursor=${encodeURIComponent(nextCursor)}`);
      if (res.ok) {
        const json = await res.json();
        setEntries((prev) => [...prev, ...(json.data ?? [])]);
        setNextCursor(parseCursorMeta(json.meta, 'standup-history-section:loadMore').nextCursor);
      }
    } finally {
      setLoadingMore(false);
    }
  }, [nextCursor, loadingMore, projectId]);

  if (loading || entries.length === 0) return null;

  const byDate: Record<string, HistoryEntry[]> = {};
  for (const e of entries) {
    if (!byDate[e.date]) byDate[e.date] = [];
    byDate[e.date].push(e);
  }
  const sortedDates = Object.keys(byDate).sort((a, b) => b.localeCompare(a));

  return (
    <section className="mt-8 space-y-3">
      <div className="flex items-center gap-2">
        <h2 className="flex items-center gap-1.5 text-sm font-semibold text-foreground">
          <ClipboardList className="h-4 w-4" aria-hidden />
          {t('history')}
        </h2>
        <Badge variant="chip">{entries.length}</Badge>
      </div>
      <div className="space-y-4">
        {sortedDates.map((date) => (
          <div key={date} className="rounded-lg border border-border bg-card p-3">
            <p className="mb-2 text-xs font-medium text-muted-foreground">{date}</p>
            <div className="space-y-2">
              {byDate[date].map((entry) => (
                <div key={entry.id} className="text-xs text-foreground/80">
                  <span className="font-medium">{memberNameById[entry.author_id] ?? entry.author_id.slice(0, 8)}</span>
                  {entry.done ? <span className="ml-2 text-muted-foreground">✅ {entry.done.slice(0, 80)}{entry.done.length > 80 ? '…' : ''}</span> : null}
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
      {nextCursor ? (
        <div className="text-center">
          <Button variant="outline" size="sm" onClick={() => void handleLoadMore()} disabled={loadingMore}>
            {loadingMore ? tCommon('loading') : tCommon('loadMore')}
          </Button>
        </div>
      ) : null}
    </section>
  );
}
