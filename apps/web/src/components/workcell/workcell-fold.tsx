'use client';

import { useId, useState } from 'react';
import { useTranslations } from 'next-intl';
import { ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ds/button';
import { LAYER } from '@/components/ds/layers';
import { Workcell, type WorkcellProps } from './workcell';

const PIPELINE_TOTAL = 6;
const PIPELINE_ORDER = ['queued', 'running', 'needs_input', 'claimed_done', 'verified', 'merge_ready'] as const;

export interface WorkcellFoldProps extends Omit<WorkcellProps, 'headerOwns'> {
  /** 근거 칸에 실제로 놓인 신호 수(검증 봉인 · 자동 검증 · 사람 결정 요청). 없으면 0 — 지어내지 않는다. */
  evidenceCount: number;
  /** 대화 수(연결된 대화 + 댓글). undefined = 아직 모름(불러오는 중) — «0»이라 단정하지 않고 «–»로 둔다. */
  conversationCount: number | undefined;
}

/**
 * 4908 — 카드 상세의 «작업 칸»을 한 줄 요약으로 접어 두는 줄. 첫 화면 맨 위는 제목 · 상태 · 담당자 · 속성(가장 잦은 손)이 쓰고,
 * 작업 칸은 있는 기능 그대로 남아 한 번 눌러 펼친다. 접힌 줄에 «단계 n/6 · 근거 · 대화»가 보여, 펼치지 않고도 현황을 읽는다.
 * 펼친 작업 칸은 호스트 머리가 제목 · 상태를 이미 말하므로 그 말을 되풀이하지 않는다(headerOwns).
 */
export function WorkcellFold({ evidenceCount, conversationCount, ...workcell }: WorkcellFoldProps) {
  const t = useTranslations('workcell');
  const [open, setOpen] = useState(false);
  const bodyId = useId();
  const stageIndex = workcell.pipelineStage ? PIPELINE_ORDER.indexOf(workcell.pipelineStage) + 1 : 0;
  const conversation = conversationCount === undefined ? '–' : String(conversationCount);
  const summary = workcell.pipelineStage
    ? t('foldSummary', { done: stageIndex, total: PIPELINE_TOTAL, evidence: evidenceCount, conversation })
    : t('foldSummaryOutside', { evidence: evidenceCount, conversation });
  return (
    <section data-testid="workcell-fold" aria-label={t('foldTitle')} className="min-w-0">
      <Button
        type="button"
        variant="quiet"
        aria-expanded={open}
        aria-controls={open ? bodyId : undefined}
        data-testid="workcell-fold-toggle"
        // 높이 44(min-h-11)는 디자인 Button 기본이 이미 준다 — 여기서 다시 쓰지 않는다(h-auto만 덮어 글이 줄바꿈될 때 늘어난다).
        onClick={() => setOpen((v) => !v)}
        className={cn(
          'h-auto w-full min-w-0 justify-start gap-2 whitespace-normal rounded-xl border border-ds-line px-3 py-2 text-left font-normal hover:bg-ds-surface-highest',
          LAYER.rowOthers,
        )}
      >
        <ChevronRight className={cn('size-4 shrink-0 text-ds-ink-3 transition-transform duration-[140ms]', open && 'rotate-90')} aria-hidden="true" />
        <span className="shrink-0 text-sm font-semibold text-ds-ink">{t('foldTitle')}</span>
        <span className="min-w-0 flex-1 text-editorial-meta text-ds-ink-2 [overflow-wrap:anywhere]" data-testid="workcell-fold-summary">{summary}</span>
        <span className="shrink-0 text-editorial-meta text-ds-action-text">{open ? t('foldCollapse') : t('foldExpand')}</span>
      </Button>
      {open ? (
        <div id={bodyId} className="mt-2">
          <Workcell {...workcell} headerOwns />
        </div>
      ) : null}
    </section>
  );
}
