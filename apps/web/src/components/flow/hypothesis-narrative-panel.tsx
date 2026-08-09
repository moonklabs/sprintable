'use client';

import { useEffect, useState } from 'react';
import { useTranslations, useLocale } from 'next-intl';
import { Loader2 } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { HypothesisStatusBadge } from '@/components/hypotheses/hypothesis-status-badge';
import type { HypothesisStatus } from '@sprintable/core-storage';
import { cn } from '@/lib/utils';

/**
 * story #2533(E-FLOW-V4 S3) — 가설 생애 수직 서사. 지구층 가설 카드를 열면 그 가설의
 * 생애를 축척을 관통해 세로로 펼친다: 질문→목표→검증→증명→(정반합)→시간선.
 *
 * ⭐status enum이 이미 담은 생애를 「비추기」(없던 상태·엔티티 신설 0).
 *
 * 리라이트(2026-08-09) — BE `GET /hypotheses/{id}/lifecycle`(story #2533-BE, PR#2931)이
 * self-FK 정반합 양방향(superseded_by/supersedes) + 목표 이름 + 스토리별 gate/evidence
 * 간접조회 + 시간선을 한 번에 준다. 이전 판(N+1: goals/{id}·stories?ids= 개별 조합)을
 * 이 단일 요청으로 교체 — PR#2930 리뷰②(증명 절이 gate/evidence를 빠뜨림)가 이 교체로
 * 자연히 풀린다.
 */
interface LifecycleGoal {
  id: string;
  title: string;
  status: string;
}

interface LifecycleStory {
  id: string;
  title: string;
  status: string;
  metric_definition: { metric?: string; target?: number; direction?: string } | null;
  outcome_status: string;
  gate_status: string | null;
  evidence_count: number;
}

interface LifecycleSuccessor {
  id: string;
  statement: string;
  status: string;
}

interface LifecycleTimeline {
  created_at: string;
  measure_after: string;
  updated_at: string;
}

interface LifecycleHypothesis {
  id: string;
  statement: string;
  status: HypothesisStatus;
  metric_definition: { metric?: string; target?: number; direction?: string } | null;
  outcome_result: Record<string, unknown> | null;
}

interface LifecycleResponse {
  hypothesis: LifecycleHypothesis;
  goals: LifecycleGoal[];
  stories: LifecycleStory[];
  superseded_by: LifecycleSuccessor | null;
  supersedes: LifecycleSuccessor[];
  timeline: LifecycleTimeline;
}

type LoadState =
  | { kind: 'loading' }
  | { kind: 'error' }
  | { kind: 'ready'; data: LifecycleResponse };

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
  const locale = useLocale();
  const [state, setState] = useState<LoadState>({ kind: 'loading' });

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(`/api/hypotheses/${hypothesisId}/lifecycle`, { cache: 'no-store' });
        if (!res.ok) throw new Error('lifecycle fetch failed');
        const data = await res.json() as LifecycleResponse;
        if (cancelled) return;
        setState({ kind: 'ready', data });
      } catch {
        if (!cancelled) setState({ kind: 'error' });
      }
    })();
    return () => { cancelled = true; };
  }, [hypothesisId]);

  const fmtDate = (iso: string) => new Date(iso).toLocaleDateString(locale);

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
            <NarrativeStep label={t('narrativeStepQuestion')} title={state.data.hypothesis.statement}>
              <HypothesisStatusBadge status={state.data.hypothesis.status} />
            </NarrativeStep>

            <NarrativeStep label={t('narrativeStepGoal')} title={t('narrativeStepGoal')}>
              {state.data.goals.length > 0 ? (
                <ul className="space-y-1">
                  {state.data.goals.map((g) => (
                    <li key={g.id}>{g.title}</li>
                  ))}
                </ul>
              ) : (
                t('narrativeNotYet')
              )}
            </NarrativeStep>

            <NarrativeStep label={t('narrativeStepVerify')} title={t('narrativeStepVerify')}>
              {state.data.hypothesis.metric_definition?.metric ? (
                <p className="mb-1">
                  {t('earthMetric')} <span className="text-foreground">{state.data.hypothesis.metric_definition.metric}</span>
                  {' · '}
                  {t('earthTarget')} <span className="text-foreground">{state.data.hypothesis.metric_definition.target}</span>
                </p>
              ) : null}
              {state.data.stories.length > 0 ? (
                <ul className="space-y-1">
                  {state.data.stories.map((s) => (
                    <li key={s.id}>{s.title}</li>
                  ))}
                </ul>
              ) : (
                t('narrativeNotYet')
              )}
            </NarrativeStep>

            <NarrativeStep label={t('narrativeStepProof')} title={t('narrativeStepProof')}>
              {state.data.hypothesis.outcome_result ? (
                <p className="mb-1.5">
                  {t('narrativeActual')}{' '}
                  <span className={cn('font-semibold', state.data.hypothesis.status === 'verified' ? 'text-success' : 'text-info')}>
                    {String((state.data.hypothesis.outcome_result as Record<string, unknown>).actual ?? '')}
                  </span>
                  {' / '}
                  {t('narrativeTarget')} {String((state.data.hypothesis.outcome_result as Record<string, unknown>).target ?? '')}
                </p>
              ) : null}
              {/* PR#2930 리뷰② — 스토리별 gate/evidence 간접조회(hypothesis_story_links 거쳐).
                  매칭이 없으면 gate_status=null·evidence_count=0("아직") 그대로 정직하게. */}
              {state.data.stories.length > 0 ? (
                <ul className="space-y-1">
                  {state.data.stories.map((s) => (
                    <li key={s.id}>
                      {s.title} — {t('narrativeGate')} {s.gate_status ?? t('narrativeNotYet')} · {t('narrativeEvidence')} {s.evidence_count}
                    </li>
                  ))}
                </ul>
              ) : state.data.hypothesis.outcome_result === null ? (
                t('narrativeNotYet')
              ) : null}
            </NarrativeStep>

            {state.data.superseded_by ? (
              <NarrativeStep label={t('narrativeStepAntithesis')} title={state.data.superseded_by.statement}>
                <HypothesisStatusBadge status={state.data.superseded_by.status as HypothesisStatus} />
              </NarrativeStep>
            ) : null}
            {state.data.supersedes.length > 0 ? (
              <NarrativeStep label={t('narrativeStepSupersedes')} title={t('narrativeStepSupersedes')}>
                <ul className="space-y-1">
                  {state.data.supersedes.map((h) => (
                    <li key={h.id} className="flex items-center gap-1.5">
                      <HypothesisStatusBadge status={h.status as HypothesisStatus} />
                      {h.statement}
                    </li>
                  ))}
                </ul>
              </NarrativeStep>
            ) : null}

            <NarrativeStep label={t('narrativeStepTimeline')} title={t('narrativeStepTimeline')}>
              {/* PR#2930 리뷰① — 이 3점은 전이 이력 «전체»가 아니다(BE도 동일 docstring으로
                  경계선을 박아둠, hypotheses.py HypothesisLifecycleTimeline). 정직하게 명시. */}
              <p className="mb-1.5 italic">{t('narrativeTimelineCaption')}</p>
              <ul className="space-y-0.5">
                <li>{t('narrativeCreatedAt', { date: fmtDate(state.data.timeline.created_at) })}</li>
                <li>{t('narrativeMeasureAfter', { date: fmtDate(state.data.timeline.measure_after) })}</li>
                <li>{t('narrativeUpdatedAt', { date: fmtDate(state.data.timeline.updated_at) })}</li>
              </ul>
            </NarrativeStep>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
