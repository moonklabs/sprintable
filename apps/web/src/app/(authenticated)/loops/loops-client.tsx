'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { GitBranch } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { EmptyState } from '@/components/ui/empty-state';
import { TopBarSlot } from '@/components/nav/top-bar-slot';
import { LoopStatusBadge, type LoopStatus } from '@/components/loops/loop-status-badge';
import { OutcomeBadge } from '@/components/loops/outcome-badge';

interface Loop {
  id: string;
  project_id: string;
  parent_loop_id: string | null;
  hypothesis_id: string | null;
  brief_doc_id: string | null;
  recipe_slug: string | null;
  title: string;
  goal_tags: string[];
  status: LoopStatus;
  outcome_snapshot: { hypothesis_status: 'verified' | 'falsified' } | null;
  created_at: string;
  updated_at: string;
}

const STATUS_FILTERS: (LoopStatus | 'all')[] = [
  'all', 'draft', 'briefing', 'generating', 'deciding', 'executing', 'measuring', 'closed', 'abandoned',
];

function LoopRow({ loop, onClick }: { loop: Loop; onClick: () => void }) {
  const t = useTranslations('loops');
  return (
    <div
      className="group w-full cursor-pointer rounded-xl border border-border bg-card px-4 py-3.5 text-left transition-all duration-150 hover:border-primary/30 hover:bg-primary/5"
      onClick={onClick}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') onClick(); }}
    >
      <div className="space-y-2">
        <div className="flex items-start justify-between gap-2">
          <p className="text-sm font-semibold leading-snug text-foreground">{loop.title}</p>
          <div className="flex shrink-0 items-center gap-1">
            <LoopStatusBadge status={loop.status} />
            {loop.status === 'closed' && loop.outcome_snapshot ? (
              <OutcomeBadge hypothesisStatus={loop.outcome_snapshot.hypothesis_status} />
            ) : null}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          {loop.parent_loop_id ? (
            <span className="inline-flex items-center gap-1">
              <GitBranch className="size-3" aria-hidden />
              {t('lineageFrom', { id: loop.parent_loop_id.slice(0, 8) })}
            </span>
          ) : null}
          {loop.recipe_slug ? <span className="font-mono">{loop.recipe_slug}</span> : null}
        </div>
        {loop.goal_tags.length > 0 ? (
          <div className="flex flex-wrap gap-1">
            {loop.goal_tags.map((tag) => (
              <Badge key={tag} variant="chip" className="text-[10px]">{tag}</Badge>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}

export function LoopsClient({ projectId }: { projectId: string }) {
  const t = useTranslations('loops');
  const router = useRouter();
  const [loops, setLoops] = useState<Loop[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState<LoopStatus | 'all'>('all');

  const fetchLoops = useCallback(async () => {
    try {
      const params = new URLSearchParams({ project_id: projectId, limit: '100' });
      if (statusFilter !== 'all') params.set('status', statusFilter);
      const res = await fetch(`/api/loops?${params.toString()}`);
      if (!res.ok) throw new Error(`Failed to fetch loops: ${res.status}`);
      const data = (await res.json()) as Loop[];
      setLoops(data);
    } catch (err) {
      console.error('[loops] 목록을 불러오지 못했습니다', err);
    } finally {
      setLoading(false);
    }
  }, [projectId, statusFilter]);

  useEffect(() => { void fetchLoops(); }, [fetchLoops]);

  if (loading) {
    return (
      <>
        <TopBarSlot title={<h1 className="text-sm font-medium">{t('title')}</h1>} />
        <div className="flex h-64 items-center justify-center">
          <p className="text-sm text-muted-foreground">{t('loading')}</p>
        </div>
      </>
    );
  }

  return (
    <>
      <TopBarSlot title={<h1 className="text-sm font-medium">{t('title')}</h1>} />
      <div className="flex h-full min-h-0 flex-col overflow-hidden">
        <div className="flex shrink-0 flex-wrap gap-1 px-4 pt-3 pb-1">
          {STATUS_FILTERS.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setStatusFilter(s)}
              className={`rounded-lg border px-2.5 py-1 text-xs font-medium transition-colors ${
                statusFilter === s
                  ? 'border-primary/40 bg-primary/10 text-primary'
                  : 'border-border text-muted-foreground hover:bg-muted/50'
              }`}
            >
              {s === 'all' ? t('filterAll') : t(`status${s.charAt(0).toUpperCase()}${s.slice(1)}` as 'statusDraft')}
            </button>
          ))}
        </div>

        <div className="flex-1 overflow-y-auto p-4">
          {loops.length === 0 ? (
            <EmptyState title={t('noLoops')} description={t('noLoopsDescription')} />
          ) : (
            <div className="mx-auto max-w-2xl space-y-2">
              {loops.map((loop) => (
                <LoopRow key={loop.id} loop={loop} onClick={() => router.push(`/loops/${loop.id}`)} />
              ))}
            </div>
          )}
        </div>
      </div>
    </>
  );
}
