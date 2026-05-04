'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Badge } from '@/components/ui/badge';

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
  const [entries, setEntries] = useState<HistoryEntry[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!projectId) return;
    setLoading(true);
    fetch(`/api/standup/history?project_id=${projectId}&limit=20`)
      .then((r) => r.json())
      .then((json) => {
        if (json?.data && Array.isArray(json.data)) setEntries(json.data);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [projectId]);

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
        <h2 className="text-sm font-semibold text-[color:var(--operator-foreground)]">
          {t('history', { defaultValue: '📋 작성 이력' })}
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
    </section>
  );
}
