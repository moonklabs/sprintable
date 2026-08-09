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
  onNavigateToGoal,
}: {
  hypothesisId: string;
  onClose: () => void;
  /** story #2535(E-FLOW-V4 S5) — 지구→대륙 다리. 목표 항목을 누르면 그 목표의 갈래(도시
   * 층)로 이동한다 — 호출부(flow-client.tsx)가 네비게이션을 책임진다(onSelectStory와
   * 같은 원칙, 이 컴포넌트는 순수 프레젠테이션). */
  onNavigateToGoal?: (goalId: string) => void;
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
                    <li key={g.id}>
                      {onNavigateToGoal ? (
                        <button
                          type="button"
                          onClick={() => onNavigateToGoal(g.id)}
                          className="text-left text-brand underline-offset-2 hover:underline"
                        >
                          {g.title} <span aria-hidden="true">→</span> {t('narrativeGoalDrilldownHint')}
                        </button>
                      ) : g.title}
                    </li>
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
              {(() => {
                const outcome = state.data.hypothesis.outcome_result as Record<string, unknown> | null;
                if (!outcome) return null;
                // 카디르 재QA 비차단①(2026-08-09) — killed 전이는 outcome_result가
                // {reason}뿐이라(actual/target 없음, backend/app/services/hypothesis.py:493)
                // 기존 actual/target 렌더가 빈 값으로 나왔다. actual이 없으면 reason으로
                // 폴백 — 둘 다 없으면 정직하게 아무것도 안 그린다(지어내지 않는다).
                if (outcome.actual === undefined) {
                  const reason = outcome.reason;
                  return typeof reason === 'string' && reason.trim() ? (
                    <p className="mb-1.5">{t('narrativeKilledReason', { reason })}</p>
                  ) : null;
                }
                return (
                  <p className="mb-1.5">
                    {t('narrativeActual')}{' '}
                    <span className={cn('font-semibold', state.data.hypothesis.status === 'verified' ? 'text-success' : 'text-info')}>
                      {String(outcome.actual ?? '')}
                    </span>
                    {' / '}
                    {t('narrativeTarget')} {String(outcome.target ?? '')}
                    {/* story #2533 follow-up②(유나 design 재검, 2026-08-09) — falsified는 색이
                        아니라 «결론 방향»(목표 미달)으로 읽히게. 방향(↑/↓)은 hypothesis 자기
                        metric_definition에서(outcome_result에도 direction이 있지만 재확認 없이
                        두 소스를 섞지 않는다 — hypothesis 레벨을 SSOT로 고정). */}
                    {state.data.hypothesis.status === 'falsified' ? (
                      <span className="ml-1.5 font-semibold text-info">
                        · {t('narrativeMissedTarget')} {state.data.hypothesis.metric_definition?.direction === 'down' ? '↓' : '↑'}
                      </span>
                    ) : null}
                  </p>
                );
              })()}
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

            {/* story #2533 follow-up③(유나 design 재검, 2026-08-09) — falsified는 «닫힘»이
                아니라 «낳음»(다음 질문을 낳는다)이 진짜 차이다. verified는 이 절 자체가 없어
                「닫힘」을 침묵으로 말하고, falsified는 이 절이 도드라져 「낳음」을 명시로
                말한다 — 색이 아니라 이 대비 자체가 신호. */}
            {state.data.superseded_by ? (
              <NarrativeStep label={t('narrativeStepAntithesis')} title={state.data.superseded_by.statement}>
                <p className="mb-1 font-medium text-info">{t('narrativeSpawned')}</p>
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
