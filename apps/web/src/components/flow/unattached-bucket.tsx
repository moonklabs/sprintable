'use client';

import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * story #2534(E-FLOW-V4 S4) — 이행기. 미매달림(가설·목표 둘 다 없는) 작업을 지구 지도에서
 * 접어 별도 버킷으로 뺀다(지도 오염 방지, doc §7-1). 강제=신규부터고 기존 2,180건은
 * backfill 강요 없이 점진 흡수 — 그래서 이 버킷은 항상 "닫힘 기본"(관제 서랍과 같은 관례).
 *
 * ⭐0수렴 «추세» 스파크라인은 이번 판에 없다 — PO 확認(2026-08-09): 미매달림 카운트의
 * 시계열/스냅샷 데이터가 BE에 전혀 없어(그라운딩으로 확인) 지금 그리면 없는 추세를
 * 지어내는 것이 된다. 디디군이 일별 스냅샷 cron을 오늘부터 쌓기 시작하고, 며칠 쌓이면
 * 후속 스토리로 스파크라인을 얹는다 — 지금은 «현재 카운트 숫자»만 정직하게 보인다.
 */
interface BucketStory {
  id: string;
  story_number?: number;
  title: string;
}

interface AttachmentCandidate {
  id: string;
  text: string;
  score: number;
}

interface AttachmentSuggestionResponse {
  suggested_type: string;
  goal_candidates: AttachmentCandidate[];
  hypothesis_candidates: AttachmentCandidate[];
}

function SuggestionChips({
  storyId,
  onAttached,
}: {
  storyId: string;
  onAttached: (storyId: string) => void;
}) {
  const t = useTranslations('flow');
  const [suggestions, setSuggestions] = useState<AttachmentSuggestionResponse | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [attachingId, setAttachingId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(`/api/stories/${storyId}/attachment-suggestions`, { cache: 'no-store' });
        if (!res.ok) throw new Error('failed');
        const json = await res.json() as AttachmentSuggestionResponse;
        if (!cancelled) setSuggestions(json);
      } catch {
        if (!cancelled) setLoadError(true);
      }
    })();
    return () => { cancelled = true; };
  }, [storyId]);

  const attachGoal = useCallback(async (goalId: string) => {
    setAttachingId(goalId);
    try {
      const res = await fetch(`/api/stories/${storyId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ epic_id: goalId }),
      });
      if (res.ok) onAttached(storyId);
    } finally {
      setAttachingId(null);
    }
  }, [storyId, onAttached]);

  const attachHypothesis = useCallback(async (hypothesisId: string) => {
    setAttachingId(hypothesisId);
    try {
      const res = await fetch(`/api/hypotheses/${hypothesisId}/links`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ story_ids: [storyId], link_type: 'supports' }),
      });
      if (res.ok) onAttached(storyId);
    } finally {
      setAttachingId(null);
    }
  }, [storyId, onAttached]);

  if (loadError) {
    return <p className="text-[11px] text-muted-foreground">{t('bucketSuggestionError')}</p>;
  }
  if (!suggestions) {
    return (
      <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
        <Loader2 className="size-3 animate-spin" aria-hidden="true" />
        {t('loading')}
      </div>
    );
  }
  const hasCandidates = suggestions.goal_candidates.length > 0 || suggestions.hypothesis_candidates.length > 0;
  if (!hasCandidates) {
    return <p className="text-[11px] text-muted-foreground">{t('bucketNoSuggestion')}</p>;
  }

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {suggestions.goal_candidates.map((c) => (
        <button
          key={c.id}
          type="button"
          disabled={attachingId !== null}
          onClick={() => void attachGoal(c.id)}
          className={cn(
            'rounded-full border border-brand/40 bg-brand/5 px-2.5 py-1 text-[11px] text-brand transition hover:bg-brand/10 disabled:opacity-50',
          )}
        >
          {t('bucketGoalChip', { text: c.text })}
        </button>
      ))}
      {suggestions.hypothesis_candidates.map((c) => (
        <button
          key={c.id}
          type="button"
          disabled={attachingId !== null}
          onClick={() => void attachHypothesis(c.id)}
          className={cn(
            'rounded-full border border-info-border bg-info-tint px-2.5 py-1 text-[11px] text-info transition hover:opacity-80 disabled:opacity-50',
          )}
        >
          {t('bucketHypothesisChip', { text: c.text })}
        </button>
      ))}
    </div>
  );
}

function BucketRow({ story, onAttached }: { story: BucketStory; onAttached: (storyId: string) => void }) {
  const t = useTranslations('flow');
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="rounded-lg border border-border bg-card p-2.5">
      <div className="flex items-center justify-between gap-2">
        <p className="min-w-0 flex-1 truncate text-xs text-foreground">{story.title}</p>
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="shrink-0 rounded-md px-2 py-1 text-[11px] font-medium text-brand hover:bg-brand/10"
        >
          {expanded ? t('bucketHideSuggestion') : t('bucketShowSuggestion')}
        </button>
      </div>
      {expanded ? (
        <div className="mt-2">
          <SuggestionChips storyId={story.id} onAttached={onAttached} />
        </div>
      ) : null}
    </div>
  );
}

export function UnattachedBucket({ projectId }: { projectId: string }) {
  const t = useTranslations('flow');
  const [stories, setStories] = useState<BucketStory[] | null>(null);
  const [loadError, setLoadError] = useState(false);

  const load = useCallback(() => {
    let cancelled = false;
    setLoadError(false);
    void (async () => {
      try {
        const res = await fetch(`/api/stories?project_id=${projectId}&unattached=true&limit=100`, { cache: 'no-store' });
        if (!res.ok) throw new Error('failed');
        const json = await res.json() as { data?: BucketStory[] };
        if (!cancelled) setStories(json.data ?? []);
      } catch {
        if (!cancelled) { setStories([]); setLoadError(true); }
      }
    })();
    return () => { cancelled = true; };
  }, [projectId]);

  useEffect(() => load(), [load]);

  const handleAttached = useCallback((storyId: string) => {
    setStories((prev) => (prev ? prev.filter((s) => s.id !== storyId) : prev));
  }, []);

  const count = stories?.length ?? 0;

  return (
    <details className="rounded-lg border border-border">
      <summary className="cursor-pointer px-3 py-2 text-xs font-semibold text-foreground">
        {stories === null ? t('loading') : t('bucketHeading', { n: count })}
      </summary>
      <div className="space-y-2 border-t border-border p-3">
        {stories === null ? (
          <div className="flex items-center gap-2 py-2 text-xs text-muted-foreground">
            <Loader2 className="size-4 animate-spin" aria-hidden="true" />
            {t('loading')}
          </div>
        ) : loadError ? (
          <p className="py-2 text-xs text-muted-foreground">{t('bucketLoadError')}</p>
        ) : stories.length === 0 ? (
          <p className="py-2 text-xs text-muted-foreground">{t('bucketEmpty')}</p>
        ) : (
          <div className="space-y-1.5">
            {stories.map((s) => (
              <BucketRow key={s.id} story={s} onAttached={handleAttached} />
            ))}
          </div>
        )}
      </div>
    </details>
  );
}
