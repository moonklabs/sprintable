'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Sparkles } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { OperatorTextarea } from '@/components/ui/operator-control';
import { cn } from '@/lib/utils';
import { DeltaTrack, fmt } from '@/components/outcome/outcome-result-card';
import { AiGenerationLoading, type AiGenerationLoadingStep } from '@/components/ai/ai-generation-loading';
import type {
  RetroHypothesisResult,
  RetroNextHypothesis,
  RetroSynthesis,
} from '@/services/retro-session';

/**
 * E-SPRINT-LOOP(81b0d17e) §7 — 스텝 수 = 실 백엔드 phase 수(가짜 phase 발명 금지). retro
 * synthesize()는 context 수집 + 2 순차 gemini 콜(L2 종합·L3 추천) = 3 스텝. 순서=파이프라인
 * 순서와 동일(진실). 타이밍은 FE heuristic — 마지막 스텝은 응답 전까지 절대 안 넘어간다.
 */
function useSynthesisLoadingSteps(t: ReturnType<typeof useTranslations>): AiGenerationLoadingStep[] {
  return [
    { label: t('loadingStep1Label'), desc: t('loadingStep1Desc') },
    { label: t('loadingStep2Label'), desc: t('loadingStep2Desc') },
    { label: t('loadingStep3Label'), desc: t('loadingStep3Desc') },
  ];
}

/**
 * 순수 타이머 스케줄 팩토리(React 비의존 — `use-doc-sync.ts`의 `createAutosaveScheduler`와 동형
 * 패턴, fake-timer 유닛테스트 용이). 실측 근거 없는 heuristic 판단값(핸드오프 관찰 ~9초 기준
 * 비례 배분, 라이브 픽셀 시 조정 가능) — 단, **캡(stepCount-1)은 honest 계약의 핵심**: 6초
 * 이후로는 절대 더 진행하지 않아 응답 도착 전까지 마지막 스텝이 계속 shimmer한다(거짓 완료 방지).
 */
export function createHeuristicStepSchedule(stepCount: number, onAdvance: (index: number) => void): { cancel: () => void } {
  const timers: ReturnType<typeof setTimeout>[] = [];
  if (stepCount > 1) {
    timers.push(setTimeout(() => onAdvance(1), 1200));
    timers.push(setTimeout(() => onAdvance(stepCount - 1), 6000));
  }
  return { cancel: () => timers.forEach(clearTimeout) };
}

function useHeuristicStepIndex(generating: boolean, stepCount: number): number {
  const [index, setIndex] = useState(0);
  // generating 전환 시 리셋 — render-phase adjustment(SynthesisBlock의 syncedFor와 동일 패턴),
  // effect body에서 곧바로 setState하지 않도록(react-hooks/set-state-in-effect).
  const [syncedFor, setSyncedFor] = useState(generating);
  if (syncedFor !== generating) {
    setSyncedFor(generating);
    if (!generating) setIndex(0);
  }
  useEffect(() => {
    if (!generating) return;
    const schedule = createHeuristicStepSchedule(stepCount, setIndex);
    return () => schedule.cancel();
  }, [generating, stepCount]);
  return index;
}

/**
 * E-SPRINT-LOOP FE(1b9f4ecb) — 회고 `closed` 단계 = sprint-close 종합 cockpit.
 * 핸드오프 `retro-sprint-close-synthesis-handoff`(§4 A안) + 렌더 시안 `retro-sprint-close-synthesis-render`
 * 1:1 시각 재현. SOUL-LOCK: 반증(falsified)/miss = 중립(info "학습")·빨강(destructive) 절대 금지.
 * AI 종합·추천 = 제안형·시각무게 < 인간 결정 액션·[채택]=인간 게이트.
 */

const VERDICT_KEY = {
  verified: 'hVerdictVerified',
  falsified: 'hVerdictFalsified',
  measuring: 'hVerdictMeasuring',
  killed: 'hVerdictKilled',
} as const;

function TallyHeader({ hypotheses }: { hypotheses: RetroHypothesisResult[] }) {
  const t = useTranslations('retro');
  const verified = hypotheses.filter((h) => h.status === 'verified').length;
  const falsified = hypotheses.filter((h) => h.status === 'falsified').length;
  const measuring = hypotheses.filter((h) => h.status === 'measuring').length;

  return (
    <div className="space-y-2.5 rounded-xl border border-border bg-card p-4">
      <h2 className="text-sm font-semibold text-foreground">{t('cockpitTitle')}</h2>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
        <span className="text-sm font-semibold tabular-nums text-foreground">{t('tallyHypotheses', { count: hypotheses.length })}</span>
        {verified > 0 ? (
          <span className="flex items-center gap-1.5 text-xs font-medium text-foreground">
            <span className="size-2 rounded-full bg-success" aria-hidden />
            <span className="tabular-nums">{t('tallyVerified', { count: verified })}</span>
          </span>
        ) : null}
        {falsified > 0 ? (
          <span className="flex items-center gap-1.5 text-xs font-medium text-foreground">
            <span className="size-2 rounded-full bg-info" aria-hidden />
            <span className="tabular-nums">{t('tallyFalsified', { count: falsified })}</span>
            <span className="text-muted-foreground">{t('tallyFalsifiedLabel')}</span>
          </span>
        ) : null}
        {measuring > 0 ? (
          <span className="flex items-center gap-1.5 text-xs font-medium text-foreground">
            <span className="size-2 rounded-full border border-dashed border-muted-foreground" aria-hidden />
            <span className="tabular-nums">{t('tallyMeasuring', { count: measuring })}</span>
          </span>
        ) : null}
      </div>
    </div>
  );
}

function HypothesisCard({ hypothesis }: { hypothesis: RetroHypothesisResult }) {
  const t = useTranslations('retro');
  const th = useTranslations('hypotheses');
  const isVerified = hypothesis.status === 'verified';
  const isFalsified = hypothesis.status === 'falsified';
  const isMeasuring = hypothesis.status === 'measuring';
  const hasMetric = hypothesis.metric != null && hypothesis.target != null && hypothesis.actual != null;

  return (
    <div
      className={cn(
        'flex flex-col gap-2 rounded-xl border p-3.5',
        isVerified && 'border-success-border bg-success-tint/40',
        isFalsified && 'border-border bg-muted/40',
        isMeasuring && 'border-dashed border-border bg-muted/20',
        hypothesis.status === 'killed' && 'border-border bg-muted/40 opacity-70',
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <p className="flex-1 text-sm font-medium leading-snug text-foreground">{hypothesis.statement}</p>
        <Badge variant={isVerified ? 'success' : isMeasuring ? 'outline' : 'chip'} className={isMeasuring ? 'border-dashed' : ''}>
          {t(VERDICT_KEY[hypothesis.status])}
        </Badge>
      </div>

      {hasMetric ? (
        <>
          <div className="flex items-baseline justify-between gap-2 text-xs">
            <span className="font-medium text-foreground">{hypothesis.metric}</span>
            <span className="tabular-nums text-muted-foreground">
              {t('hTargetLine', {
                dir: hypothesis.direction === 'down' ? th('dirDown') : th('dirUp'),
                target: fmt(hypothesis.target as number),
                actual: fmt(hypothesis.actual as number),
              })}
            </span>
          </div>
          <DeltaTrack
            target={hypothesis.target as number}
            actual={hypothesis.actual as number}
            isHit={isVerified}
            targetLabel={th('target')}
          />
        </>
      ) : isMeasuring ? (
        <p className="flex items-center gap-1.5 text-[10.5px] text-muted-foreground">
          <span className="size-1.5 rounded-full border border-dashed border-muted-foreground" aria-hidden />
          {hypothesis.measure_after ? t('hMeasuringNote', { date: hypothesis.measure_after.slice(0, 10) }) : t('hMeasuringNoteNoDate')}
        </p>
      ) : null}

      {isFalsified ? (
        <p className="flex items-center gap-1.5 text-[10.5px] text-info">
          <Badge variant="info" className="text-[9.5px]">{t('hLearnBadge')}</Badge>
          {t('hLearnNote')}
        </p>
      ) : null}

      {hypothesis.href && (isVerified || isFalsified) ? (
        <a href={hypothesis.href} className="self-start text-[10px] text-muted-foreground underline decoration-dotted underline-offset-2 hover:text-foreground">
          {t('hViewLink')}
        </a>
      ) : null}
    </div>
  );
}

function SynthesisBlock({
  synthesis,
  onRegenerate,
}: {
  synthesis: RetroSynthesis;
  onRegenerate: () => void;
}) {
  const t = useTranslations('retro');
  const [editing, setEditing] = useState(false);
  const [drafts, setDrafts] = useState<string[]>(() => synthesis.learned.map((l) => l.text));

  // synthesis가 바뀌면(재생성) 로컬 편집본도 최신으로 리셋.
  const [syncedFor, setSyncedFor] = useState(synthesis.generated_at);
  if (syncedFor !== synthesis.generated_at) {
    setSyncedFor(synthesis.generated_at);
    setDrafts(synthesis.learned.map((l) => l.text));
    setEditing(false);
  }

  return (
    <div className="flex flex-col gap-2.5 rounded-xl border border-border bg-info-tint/10 p-4">
      <div className="flex items-center gap-2">
        <Sparkles className="size-3.5 text-info" aria-hidden />
        <h2 className="flex-1 text-sm font-semibold text-foreground">{t('synthesisTitle')}</h2>
        <Badge variant="info">{t('aiDraftBadge')}</Badge>
      </div>

      <div className="flex flex-col gap-2">
        {synthesis.learned.map((item, i) => (
          <div key={i} className="flex items-start gap-2">
            <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-info" aria-hidden />
            {editing ? (
              <OperatorTextarea
                value={drafts[i] ?? item.text}
                onChange={(e) => setDrafts((prev) => { const next = [...prev]; next[i] = e.target.value; return next; })}
                rows={2}
                className="flex-1"
              />
            ) : (
              <p className="flex-1 text-[13px] leading-snug text-foreground">
                {drafts[i] ?? item.text}
                {item.source ? <span className="ml-1.5 block text-[10px] text-muted-foreground">{item.source}</span> : null}
              </p>
            )}
          </div>
        ))}
      </div>

      <div className="flex items-center gap-2 border-t border-border/70 pt-2.5">
        {editing ? <p className="flex-1 text-[10px] text-muted-foreground">{t('synthesisEditHint')}</p> : <p className="flex-1 text-[10px] text-muted-foreground">{t('synthesisFooterNote')}</p>}
        <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" onClick={() => setEditing((v) => !v)}>
          {editing ? t('synthesisEditDone') : t('synthesisEdit')}
        </Button>
        <Button variant="outline" size="sm" className="h-6 px-2 text-xs" onClick={onRegenerate}>
          {t('synthesisRegenerate')}
        </Button>
      </div>
    </div>
  );
}

function confidenceBucket(confidence: number | null | undefined): 'low' | 'mid' | 'high' | null {
  if (confidence == null) return null;
  if (confidence >= 0.7) return 'high';
  if (confidence >= 0.4) return 'mid';
  return 'low';
}

function RecommendationCard({
  rec,
  seeded,
  ignored,
  adopting,
  onAdopt,
  onIgnore,
}: {
  rec: RetroNextHypothesis;
  seeded: boolean;
  ignored: boolean;
  adopting: boolean;
  onAdopt: (statement: string) => void;
  onIgnore: () => void;
}) {
  const t = useTranslations('retro');
  const th = useTranslations('hypotheses');
  const [editing, setEditing] = useState(false);
  const [statement, setStatement] = useState(rec.statement);
  const bucket = confidenceBucket(rec.confidence);
  const barWidth = rec.confidence != null ? Math.round(rec.confidence * 100) : 0;

  if (ignored) return null;

  if (seeded) {
    return (
      <div className="flex flex-col gap-2 rounded-xl border border-success-border bg-success-tint/40 p-3.5">
        <p className="text-sm font-medium leading-snug text-foreground">{statement}</p>
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="success">{t('recSeededBadge')}</Badge>
          <Badge variant="chip">{t('recSeededChip')}</Badge>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2.5 rounded-xl border border-border bg-card p-3.5">
      {editing ? (
        <OperatorTextarea value={statement} onChange={(e) => setStatement(e.target.value)} rows={2} />
      ) : (
        <p className="text-sm font-medium leading-snug text-foreground">{statement}</p>
      )}

      {rec.metric_definition ? (
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge variant="chip" className="text-[10px]">
            {t('recMetricChip', { metric: rec.metric_definition.metric, dir: rec.metric_definition.direction === 'down' ? th('dirDown') : th('dirUp'), target: fmt(rec.metric_definition.target) })}
          </Badge>
        </div>
      ) : null}

      {rec.rationale ? (
        <p className="flex items-start gap-1.5 text-[10.5px] leading-snug text-muted-foreground">
          <span className="text-info" aria-hidden>{t('recWhyPrefix')}</span>
          {rec.rationale}
        </p>
      ) : null}

      <div className="flex items-center gap-2 border-t border-border/70 pt-2.5">
        {bucket ? (
          <span className="flex flex-1 items-center gap-1.5 text-[10px] text-muted-foreground">
            {t('recConfidenceLabel')}
            <span className="h-1 w-9 overflow-hidden rounded-full bg-muted">
              <span className="block h-full rounded-full bg-info" style={{ width: `${barWidth}%` }} />
            </span>
            {bucket === 'high' ? t('recConfHigh') : bucket === 'mid' ? t('recConfMid') : t('recConfLow')}
          </span>
        ) : <span className="flex-1" />}
        <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" onClick={onIgnore}>{t('recIgnore')}</Button>
        <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" onClick={() => setEditing((v) => !v)}>
          {editing ? t('recEditDone') : t('recEdit')}
        </Button>
        <Button variant="hero" size="sm" className="h-6 px-2.5 text-xs" onClick={() => onAdopt(statement)} disabled={adopting}>
          {adopting ? t('recAdopting') : t('recAdopt')}
        </Button>
      </div>
    </div>
  );
}

export function SprintCloseCockpit({
  hypotheses,
  synthesis,
  nextHypotheses,
  onGenerateSynthesis,
  onAdoptRecommendation,
}: {
  hypotheses: RetroHypothesisResult[];
  synthesis: RetroSynthesis | null;
  nextHypotheses: RetroNextHypothesis[];
  onGenerateSynthesis: () => Promise<boolean>;
  onAdoptRecommendation: (rec: RetroNextHypothesis, statement: string) => Promise<boolean>;
}) {
  const t = useTranslations('retro');
  const [generating, setGenerating] = useState(false);
  const [generateError, setGenerateError] = useState(false);
  const [seededIndexes, setSeededIndexes] = useState<Set<number>>(new Set());
  const [ignoredIndexes, setIgnoredIndexes] = useState<Set<number>>(new Set());
  const [adoptingIndex, setAdoptingIndex] = useState<number | null>(null);
  const [adoptError, setAdoptError] = useState<number | null>(null);
  const loadingSteps = useSynthesisLoadingSteps(t);
  const activeStepIndex = useHeuristicStepIndex(generating, loadingSteps.length);

  const measuringOnly = hypotheses.length > 0 && hypotheses.every((h) => h.status === 'measuring');

  async function handleGenerate() {
    setGenerating(true);
    setGenerateError(false);
    try {
      const ok = await onGenerateSynthesis();
      if (!ok) setGenerateError(true);
    } finally {
      setGenerating(false);
    }
  }

  async function handleAdopt(index: number, rec: RetroNextHypothesis, statement: string) {
    setAdoptingIndex(index);
    setAdoptError(null);
    try {
      const ok = await onAdoptRecommendation(rec, statement);
      if (ok) setSeededIndexes((prev) => new Set([...prev, index]));
      else setAdoptError(index);
    } finally {
      setAdoptingIndex(null);
    }
  }

  return (
    <div className="space-y-4">
      <TallyHeader hypotheses={hypotheses} />

      <div className="space-y-2">
        <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">{t('hypothesesSectionTitle')}</p>
        {hypotheses.length === 0 ? (
          <p className="text-xs text-muted-foreground">{t('hEmptyNone')}</p>
        ) : measuringOnly ? (
          <p className="text-xs text-muted-foreground">{t('hEmptyMeasuringOnly')}</p>
        ) : (
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            {hypotheses.map((h) => <HypothesisCard key={h.id} hypothesis={h} />)}
          </div>
        )}
      </div>

      {generating ? (
        <AiGenerationLoading
          headline={t('loadingHeadlineSynthesis')}
          steps={loadingSteps}
          activeIndex={activeStepIndex}
          skeleton="synthesis"
          transline={t('loadingTranslineSynthesis')}
        />
      ) : synthesis ? (
        <SynthesisBlock synthesis={synthesis} onRegenerate={() => void handleGenerate()} />
      ) : (
        <div className="flex flex-col items-center gap-2.5 rounded-xl border border-dashed border-border bg-muted/20 p-5 text-center">
          <Sparkles className="size-4 text-info" aria-hidden />
          <p className="text-xs text-muted-foreground">{t('synthesisGenerateHint')}</p>
          {generateError ? <p className="text-xs text-destructive">{t('synthesisGenerateFailed')}</p> : null}
          <Button variant="outline" size="sm" onClick={() => void handleGenerate()}>
            {t('synthesisGenerateCta')}
          </Button>
        </div>
      )}

      {!generating && synthesis && nextHypotheses.length > 0 ? (
        <div className="space-y-2.5">
          <div className="flex items-center gap-2">
            <Sparkles className="size-3.5 text-info" aria-hidden />
            <h2 className="text-sm font-semibold text-foreground">{t('recTitle')}</h2>
            <Badge variant="info">{t('aiDraftBadge')}</Badge>
          </div>
          <div className="space-y-2.5">
            {nextHypotheses.map((rec, i) => (
              <div key={i} className="space-y-1">
                <RecommendationCard
                  rec={rec}
                  seeded={seededIndexes.has(i)}
                  ignored={ignoredIndexes.has(i)}
                  adopting={adoptingIndex === i}
                  onAdopt={(statement) => void handleAdopt(i, rec, statement)}
                  onIgnore={() => setIgnoredIndexes((prev) => new Set([...prev, i]))}
                />
                {adoptError === i ? <p className="text-xs text-destructive">{t('recAdoptFailed')}</p> : null}
              </div>
            ))}
          </div>
          <div className="flex items-start gap-2 rounded-lg border border-info-border bg-info-tint/30 p-2.5 text-[10.5px] leading-snug text-foreground">
            <span className="font-semibold text-info" aria-hidden>ⓘ</span>
            {t('hitlBanner')}
          </div>
        </div>
      ) : null}
    </div>
  );
}
