'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { GitBranch, Plus } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { TopBarSlot } from '@/components/nav/top-bar-slot';
import { LoopStatusBadge, type LoopStatus } from '@/components/loops/loop-status-badge';
import { OutcomeBadge } from '@/components/loops/outcome-badge';
import { LoopCreateDialog } from '@/components/loops/loop-create-dialog';

// doc resource-view-firsttouch-identity-pattern §2/§4 — 실험실(loops) 파일럿: 빈 first-touch를
// "없습니다"가 아니라 정체성 explainer로. §4 visual 열 "4노드 사이클"을 최소 subtle glyph로
// 표현(장식 아닌 의미 — 가설→실행→검증→학습 4단계를 카디널 4점+점선 호로 암시).
function LoopCycleGlyph() {
  return (
    <svg viewBox="0 0 48 48" className="size-9" aria-hidden="true">
      <path
        d="M24 8 A16 16 0 1 1 8 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeDasharray="1 5"
      />
      <circle cx="24" cy="8" r="2.5" fill="currentColor" />
      <circle cx="40" cy="24" r="2.5" fill="currentColor" />
      <circle cx="24" cy="40" r="2.5" fill="currentColor" />
      <circle cx="8" cy="24" r="2.5" fill="currentColor" />
    </svg>
  );
}

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

export function LoopsClient({ projectId, wsSlug, projSlug }: { projectId: string; wsSlug: string; projSlug: string }) {
  const t = useTranslations('loops');
  const router = useRouter();
  const [loops, setLoops] = useState<Loop[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState<LoopStatus | 'all'>('all');
  const [createOpen, setCreateOpen] = useState(false);

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
      <TopBarSlot
        title={<h1 className="text-sm font-medium">{t('title')}</h1>}
        actions={
          <Button size="sm" onClick={() => setCreateOpen(true)}>
            <Plus className="size-3.5" />
            {t('createLoopCta')}
          </Button>
        }
      />
      <LoopCreateDialog
        projectId={projectId}
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={(loop) => router.push(`/${wsSlug}/${projSlug}/loops/${loop.id}`)}
      />
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
            <EmptyState
              icon={<LoopCycleGlyph />}
              title={t('noLoops')}
              description={t('noLoopsDescription')}
              action={
                <div className="flex flex-col items-center gap-1.5">
                  <Button size="sm" onClick={() => setCreateOpen(true)}>
                    <Plus className="size-3.5" />
                    {t('noLoopsCta')}
                  </Button>
                  <p className="text-xs text-muted-foreground">{t('noLoopsAiHint')}</p>
                </div>
              }
            />
          ) : (
            <div className="mx-auto max-w-2xl space-y-2">
              {loops.map((loop) => (
                <LoopRow key={loop.id} loop={loop} onClick={() => router.push(`/${wsSlug}/${projSlug}/loops/${loop.id}`)} />
              ))}
            </div>
          )}
        </div>
      </div>
    </>
  );
}
