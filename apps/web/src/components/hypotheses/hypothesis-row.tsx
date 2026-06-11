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
  const isDraft =
    hypothesis.status === 'proposed' && (hypothesis.draft_metadata as { confirmed?: boolean } | null)?.confirmed !== true;
  const linkedCount = hypothesis.story_ids?.length ?? 0;
  const killed = hypothesis.status === 'killed';

  return (
    <div className="rounded-xl border border-border bg-background px-3 py-2.5">
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          <HypothesisStatusBadge status={hypothesis.status} />
          {isDraft ? (
            <Badge variant="outline" className="border-dashed text-muted-foreground">
              {t('draftPin')}
            </Badge>
          ) : null}
        </div>
        <HypothesisActions hypothesis={hypothesis} actions={actions} isDraft={isDraft} t={t} />
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

      {isDraft ? (
        <div className="mt-2">
          <button
            type="button"
            onClick={() => actions.onConfirmDraft(hypothesis)}
            className="rounded-lg border border-border px-2.5 py-1 text-xs font-medium text-foreground transition hover:border-primary hover:text-primary"
          >
            {t('confirmDraft')}
          </button>
        </div>
      ) : null}
    </div>
  );
}

function HypothesisActions({
  hypothesis,
  actions,
  isDraft,
  t,
}: {
  hypothesis: Hypothesis;
  actions: HypothesisRowActions;
  isDraft: boolean;
  t: ReturnType<typeof useTranslations>;
}) {
  const canActivate = hypothesis.status === 'proposed' && !isDraft;
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
        {canActivate ? (
          <DropdownMenuItem onClick={() => actions.onActivate(hypothesis)}>
            <Play className="mr-2 size-4" />
            {t('activate')}
          </DropdownMenuItem>
        ) : null}
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
