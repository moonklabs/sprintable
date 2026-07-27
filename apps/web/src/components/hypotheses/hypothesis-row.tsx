'use client';

import { useTranslations } from 'next-intl';
import { MoreHorizontal, Link2, Play, XCircle, CheckCircle2, CircleSlash } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import type { Hypothesis } from '@sprintable/core-storage';
import { HypothesisStatusBadge } from './hypothesis-status-badge';

const fmt = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(2));

export interface HypothesisRowActions {
  onConfirmDraft: (h: Hypothesis) => void;
  onActivate: (h: Hypothesis) => void;
  onLinkStory: (h: Hypothesis) => void;
  onKill: (h: Hypothesis) => void;
  // story #2036 — measuring 가설을 사람이 달성/반증으로 닫는 진입점(다이얼로그는 호출부가 연다).
  onResolve: (h: Hypothesis, target: 'verified' | 'falsified') => void;
  // story #2053 — active→measuring 전이 동선이 화면에 아예 없어 종결 메뉴(measuring 전용)에
  // 도달할 수 없던 결함. 서버(hypothesis.py transition_hypothesis)엔 이 전이에 measure_after/
  // 지표정의 요건이 없다(실측 확認) — 그냥 시작되면 되므로 별도 입력 다이얼로그 없이 1스텝.
  onStartMeasuring: (h: Hypothesis) => void;
}

/** Compact in-flight / terminal row (§4.2). verified/falsified use the VerdictCard instead. */
export function HypothesisRow({
  hypothesis,
  actions,
}: {
  hypothesis: Hypothesis;
  actions: HypothesisRowActions;
}) {
  const t = useTranslations('hypotheses');
  const md = hypothesis.metric_definition;
  // 초안 = AI 템플릿 초안(draft_metadata.template===true)·아직 미확인. 핸드오프 §5 ⓐ 기준
  // (PO 콜: FE 인터임 hack 금지. BE가 HypothesisResponse에 draft_metadata/drafted_by를
  // additive 노출). 필드 노출 전엔 template이 undefined라 모든 proposed가 비-draft로 떨어져
  // [활성화] flow가 정상 동작하고, 노출되면 AI 초안만 핀/확인이 자연히 살아난다(revert 불필요).
  const draftMeta = hypothesis.draft_metadata as { template?: boolean; confirmed?: boolean } | null;
  const needsConfirm =
    hypothesis.status === 'proposed' && draftMeta?.template === true && draftMeta?.confirmed !== true;
  // §12.2ⓑ: 확인 직후(또는 휴먼 proposed) 같은 자리에 [활성화]를 인라인 연속 노출.
  const canActivateInline = hypothesis.status === 'proposed' && !needsConfirm;
  // story #2053 — active 가설에서 measuring으로 옮기는 동선. §12.2ⓑ [활성화]와 동일하게
  // row 인라인 연속 노출(사람이 찾을 수 있는 자리, AC1) — ⋯ 메뉴에 숨기지 않는다.
  const canStartMeasuringInline = hypothesis.status === 'active';
  const linkedCount = hypothesis.story_ids?.length ?? 0;
  const killed = hypothesis.status === 'killed';

  return (
    <div className="rounded-xl border border-border bg-background px-3 py-2.5">
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          <HypothesisStatusBadge status={hypothesis.status} />
          {needsConfirm ? (
            <Badge variant="outline" className="border-dashed text-muted-foreground">
              {t('draftPin')}
            </Badge>
          ) : null}
        </div>
        <HypothesisActions hypothesis={hypothesis} actions={actions} t={t} />
      </div>

      <p className={cn('mt-1.5 line-clamp-2 text-sm leading-6 text-foreground', killed && 'text-muted-foreground line-through')}>
        {hypothesis.statement}
      </p>

      <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
        {md?.metric ? (
          <span className="tabular-nums">
            📈 {md.metric} {md.direction === 'down' ? '≤' : '≥'} {fmt(md.target)}
          </span>
        ) : null}
        {hypothesis.measure_after ? (
          <>
            <span className="text-border">·</span>
            <span>{hypothesis.measure_after.slice(0, 10)}</span>
          </>
        ) : null}
        {linkedCount > 0 ? (
          <>
            <span className="text-border">·</span>
            <span>🔗 {linkedCount}</span>
          </>
        ) : null}
        <span className="text-border">·</span>
        <span>@{hypothesis.owner_member_id?.slice(0, 8) ?? t('owner')}</span>
      </div>

      {/* §12.2ⓑ: 초안이면 [초안 확인], 확인됨/휴먼 proposed면 같은 자리에 [활성화] 연속 노출. */}
      {needsConfirm ? (
        <div className="mt-2">
          <button
            type="button"
            onClick={() => actions.onConfirmDraft(hypothesis)}
            className="rounded-lg border border-border px-2.5 py-1 text-xs font-medium text-foreground transition hover:border-primary hover:text-primary"
          >
            {t('confirmDraft')}
          </button>
        </div>
      ) : canActivateInline ? (
        <div className="mt-2">
          <button
            type="button"
            onClick={() => actions.onActivate(hypothesis)}
            className="inline-flex items-center gap-1 rounded-lg border border-border px-2.5 py-1 text-xs font-medium text-foreground transition hover:border-primary hover:text-primary"
          >
            <Play className="size-3" />
            {t('activate')}
          </button>
        </div>
      ) : canStartMeasuringInline ? (
        <div className="mt-2">
          <button
            type="button"
            onClick={() => actions.onStartMeasuring(hypothesis)}
            title={hypothesis.measure_after ? t('startMeasuringHintWithDate', { date: hypothesis.measure_after.slice(0, 10) }) : t('startMeasuringHint')}
            className="inline-flex items-center gap-1 rounded-lg border border-border px-2.5 py-1 text-xs font-medium text-foreground transition hover:border-primary hover:text-primary"
          >
            <Play className="size-3" />
            {t('startMeasuring')}
          </button>
          {/* AC2: 동선의 의미를 문구로 — "측정 시작"이 언제부터 재는지 사람이 알 수 있게. */}
          <p className="mt-1 text-[11px] text-muted-foreground">
            {hypothesis.measure_after ? t('startMeasuringHintWithDate', { date: hypothesis.measure_after.slice(0, 10) }) : t('startMeasuringHint')}
          </p>
        </div>
      ) : null}
    </div>
  );
}

function HypothesisActions({
  hypothesis,
  actions,
  t,
}: {
  hypothesis: Hypothesis;
  actions: HypothesisRowActions;
  t: ReturnType<typeof useTranslations>;
}) {
  // 활성화는 §12.2ⓑ대로 row 인라인에 노출(연속 흐름) — 메뉴엔 연결/kill/달성/반증만.
  const canKill = hypothesis.status === 'proposed' || hypothesis.status === 'active' || hypothesis.status === 'measuring';
  // story #2036 — 달성/반증은 measuring 상태에서만 열린다(BE 합법 전이가 measuring→verified|falsified뿐).
  const canResolve = hypothesis.status === 'measuring';

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={t('actions')}
        className="inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
      >
        <MoreHorizontal className="size-4" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-44">
        <DropdownMenuItem onClick={() => actions.onLinkStory(hypothesis)}>
          <Link2 className="mr-2 size-4" />
          {t('linkStory')}
        </DropdownMenuItem>
        {canResolve ? (
          <>
            <DropdownMenuItem onClick={() => actions.onResolve(hypothesis, 'verified')} className="text-success focus:text-success">
              <CheckCircle2 className="mr-2 size-4" />
              {t('resolveVerify')}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => actions.onResolve(hypothesis, 'falsified')} className="text-info focus:text-info">
              <CircleSlash className="mr-2 size-4" />
              {t('resolveFalsify')}
            </DropdownMenuItem>
          </>
        ) : null}
        {canKill ? (
          <DropdownMenuItem onClick={() => actions.onKill(hypothesis)} className="text-destructive focus:text-destructive">
            <XCircle className="mr-2 size-4" />
            {t('kill')}
          </DropdownMenuItem>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
