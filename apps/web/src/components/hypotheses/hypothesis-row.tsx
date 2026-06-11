'use client';

import { useTranslations } from 'next-intl';
import { MoreHorizontal, Link2, Play, XCircle } from 'lucide-react';
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
  // (PO 콜: FE 인터임 hack 금지. 디디 BE가 HypothesisResponse에 draft_metadata/drafted_by를
  // additive 노출). 필드 노출 전엔 template이 undefined라 모든 proposed가 비-draft로 떨어져
  // [활성화] flow가 정상 동작하고, 노출되면 AI 초안만 핀/확인이 자연히 살아난다(revert 불필요).
  const draftMeta = hypothesis.draft_metadata as { template?: boolean; confirmed?: boolean } | null;
  const needsConfirm =
    hypothesis.status === 'proposed' && draftMeta?.template === true && draftMeta?.confirmed !== true;
  // §12.2ⓑ: 확인 직후(또는 휴먼 proposed) 같은 자리에 [활성화]를 인라인 연속 노출.
  const canActivateInline = hypothesis.status === 'proposed' && !needsConfirm;
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
  // 활성화는 §12.2ⓑ대로 row 인라인에 노출(연속 흐름) — 메뉴엔 연결/kill만.
  const canKill = hypothesis.status === 'proposed' || hypothesis.status === 'active' || hypothesis.status === 'measuring';

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
