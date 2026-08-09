'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Loader2 } from 'lucide-react';
import type { Hypothesis } from '@sprintable/core-storage';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { HypothesisStatusBadge } from '@/components/hypotheses/hypothesis-status-badge';
import { cn } from '@/lib/utils';

/**
 * story #2533(E-FLOW-V4 S3) — 가설 생애 수직 서사. 지구층 가설 카드를 열면 그 가설의
 * 생애를 축척을 관통해 세로로 펼친다: 질문→목표→검증→증명→(정반합)→시간선.
 *
 * ⭐status enum이 이미 담은 생애를 «비추기»(없던 것 만들기 아님) — 새 상태·새 엔티티 0개,
 * 전부 기존 Hypothesis 필드+기존 API(goals/stories)의 재조립.
 *
 * 정반합(falsified→대체)은 그라운딩 결과 DB에 구조적 링크가 없었다(디디 BE #2533-후속
 * `superseded_by_hypothesis_id` 대기 中) — 필드가 오기 전까진 옵셔널로 안전히 읽고,
 * 없으면 그 절만 통째로 생략한다(추측 연결 금지·없는 데이터에 화면 안 깎기).
 */
type HypothesisWithSupersession = Hypothesis & {
  superseded_by_hypothesis_id?: string | null;
};

interface GoalSummary {
  id: string;
  title: string;
  status: string;
}

interface StorySummary {
  id: string;
  story_number?: number;
  title: string;
  status: string;
}

type LoadState =
  | { kind: 'loading' }
  | { kind: 'error' }
  | {
      kind: 'ready';
      hypothesis: HypothesisWithSupersession;
      goals: GoalSummary[];
      stories: StorySummary[];
      supersededBy: HypothesisWithSupersession | null;
    };

function NarrativeStep({
  label,
  title,
  children,
}: {
  label: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="relative border-l-2 border-border pb-6 pl-5 last:pb-0">
      <span aria-hidden="true" className="absolute -left-[7px] top-0.5 size-3 rounded-full border-2 border-background bg-brand" />
      <div className="mb-1 flex items-baseline gap-2">
        <span className="text-[10px] font-bold tracking-wide text-brand">{label}</span>
        <h3 className="text-sm font-semibold text-foreground">{title}</h3>
      </div>
      <div className="text-xs text-muted-foreground">{children}</div>
    </div>
  );
}

export function HypothesisNarrativePanel({
  hypothesisId,
  onClose,
}: {
  hypothesisId: string;
  onClose: () => void;
}) {
  const t = useTranslations('flow');
  const [state, setState] = useState<LoadState>({ kind: 'loading' });

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const hypRes = await fetch(`/api/hypotheses/${hypothesisId}`, { cache: 'no-store' });
        if (!hypRes.ok) throw new Error('hypothesis fetch failed');
        const hypJson = await hypRes.json() as { data?: HypothesisWithSupersession };
        const hypothesis = hypJson.data;
        if (!hypothesis) throw new Error('hypothesis missing');
        if (cancelled) return;

        const [goals, stories, supersededBy] = await Promise.all([
          Promise.all(
            (hypothesis.epic_ids ?? []).map((id) =>
              fetch(`/api/goals/${id}`, { cache: 'no-store' })
                .then((r) => (r.ok ? r.json() : null))
                .then((j: { data?: GoalSummary } | null) => j?.data ?? null)
                .catch(() => null),
            ),
          ).then((list) => list.filter((g): g is GoalSummary => g !== null)),
          hypothesis.story_ids?.length
            ? fetch(`/api/stories?ids=${hypothesis.story_ids.join(',')}`, { cache: 'no-store' })
                .then((r) => (r.ok ? r.json() : null))
                .then((j: { data?: StorySummary[] } | null) => j?.data ?? [])
                .catch(() => [])
            : Promise.resolve([]),
          hypothesis.superseded_by_hypothesis_id
            ? fetch(`/api/hypotheses/${hypothesis.superseded_by_hypothesis_id}`, { cache: 'no-store' })
                .then((r) => (r.ok ? r.json() : null))
                .then((j: { data?: HypothesisWithSupersession } | null) => j?.data ?? null)
                .catch(() => null)
            : Promise.resolve(null),
        ]);
        if (cancelled) return;
        setState({ kind: 'ready', hypothesis, goals, stories, supersededBy });
      } catch {
        if (!cancelled) setState({ kind: 'error' });
      }
    })();
    return () => { cancelled = true; };
  }, [hypothesisId]);

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{t('narrativeTitle')}</DialogTitle>
        </DialogHeader>

        {state.kind === 'loading' ? (
          <div className="flex items-center gap-2 py-6 text-xs text-muted-foreground">
            <Loader2 className="size-4 animate-spin" aria-hidden="true" />
            {t('loading')}
          </div>
        ) : state.kind === 'error' ? (
          <p className="py-4 text-xs text-muted-foreground">{t('narrativeLoadError')}</p>
        ) : (
          <div className="mt-2">
            <NarrativeStep label={t('narrativeStepQuestion')} title={state.hypothesis.statement}>
              <HypothesisStatusBadge status={state.hypothesis.status} />
            </NarrativeStep>

            <NarrativeStep label={t('narrativeStepGoal')} title={t('narrativeStepGoal')}>
              {state.goals.length > 0 ? (
                <ul className="space-y-1">
                  {state.goals.map((g) => (
                    <li key={g.id}>{g.title}</li>
                  ))}
                </ul>
              ) : (
                t('narrativeNotYet')
              )}
            </NarrativeStep>

            <NarrativeStep label={t('narrativeStepVerify')} title={t('narrativeStepVerify')}>
              <p className="mb-1">
                {t('earthMetric')} <span className="text-foreground">{state.hypothesis.metric_definition?.metric}</span>
                {' · '}
                {t('earthTarget')} <span className="text-foreground">{state.hypothesis.metric_definition?.target}</span>
              </p>
              {state.stories.length > 0 ? (
                <ul className="space-y-1">
                  {state.stories.map((s) => (
                    <li key={s.id}>{s.title}</li>
                  ))}
                </ul>
              ) : (
                t('narrativeNotYet')
              )}
            </NarrativeStep>

            <NarrativeStep label={t('narrativeStepProof')} title={t('narrativeStepProof')}>
              {state.hypothesis.outcome_result ? (
                <p>
                  {t('narrativeActual')}{' '}
                  <span className={cn('font-semibold', state.hypothesis.status === 'verified' ? 'text-success' : 'text-info')}>
                    {String((state.hypothesis.outcome_result as Record<string, unknown>).actual ?? '')}
                  </span>
                  {' / '}
                  {t('narrativeTarget')} {String((state.hypothesis.outcome_result as Record<string, unknown>).target ?? '')}
                </p>
              ) : (
                t('narrativeNotYet')
              )}
            </NarrativeStep>

            {state.hypothesis.status === 'falsified' && state.supersededBy ? (
              <NarrativeStep label={t('narrativeStepAntithesis')} title={state.supersededBy.statement}>
                <HypothesisStatusBadge status={state.supersededBy.status} />
              </NarrativeStep>
            ) : null}

            <NarrativeStep label={t('narrativeStepTimeline')} title={t('narrativeStepTimeline')}>
              <ul className="space-y-0.5">
                <li>{t('narrativeCreatedAt', { date: new Date(state.hypothesis.created_at).toLocaleDateString('ko-KR') })}</li>
                <li>{t('narrativeMeasureAfter', { date: new Date(state.hypothesis.measure_after).toLocaleDateString('ko-KR') })}</li>
                <li>{t('narrativeUpdatedAt', { date: new Date(state.hypothesis.updated_at).toLocaleDateString('ko-KR') })}</li>
              </ul>
            </NarrativeStep>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
