'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import type { ChatMessage } from '@/hooks/use-chat-sse';
import type { EntityStatusFetchState } from './entity-status-labels';
import type { ReadingPanelTarget } from './reading-panel';
import type { EventDefinitionSummary } from '@/lib/block-template';
import { ChatMarkdown } from './chat-bubble';
import { MaterialChip } from '@/components/ui/material-chip';
import { computeReportDensity, RESULT_KICKER_LABEL } from '@/lib/chat-report-density';

interface ReportMessageSummaryProps {
  content: string;
  messageKind?: string | null;
  isMine: boolean;
  references: ChatMessage['references'];
  entityStatusByKey?: Record<string, EntityStatusFetchState>;
  onOpenReadingPanel?: (target: ReadingPanelTarget) => void;
  eventDefinitionsByKey?: Record<string, EventDefinitionSummary> | null;
}

/**
 * story #ec57c80c(v2 3호, 아티팩트 2fdc81aa) — 에이전트 report성 메시지 밀도 재설계. 소스
 * (메시지 content)는 무변경 — 표현 층 전용. 발동 조건(computeReportDensity) 미충족이거나
 * 펼친 상태면 기존 `ChatMarkdown` 경로 그대로(회귀 0, 사본 분화 금지) — 새 마크업은 접힌
 * 상태(kicker+리드+최상위 목록+더 보기)일 때만 나타난다.
 */
export function ReportMessageSummary({
  content, messageKind, isMine, references, entityStatusByKey, onOpenReadingPanel, eventDefinitionsByKey,
}: ReportMessageSummaryProps) {
  const t = useTranslations('chats');
  const [expanded, setExpanded] = useState(false);
  const density = computeReportDensity(content, messageKind);

  if (!density || expanded) {
    return (
      <>
        <ChatMarkdown
          content={content} isMine={isMine} references={references} entityStatusByKey={entityStatusByKey}
          onOpenReadingPanel={onOpenReadingPanel} eventDefinitionsByKey={eventDefinitionsByKey}
        />
        {density ? (
          <button
            type="button"
            onClick={() => setExpanded(false)}
            className="mt-1 text-[11px] font-medium text-primary hover:underline"
          >
            {t('reportCollapse')}
          </button>
        ) : null}
      </>
    );
  }

  // story #5c29454b(③ result 카드, doc result-card-final-spec-5c29454b) — 판정 dot은
  // kicker가 정확히 «판정»일 때만(요청/핸드오프/확인 kicker엔 성공/반려 개념이 없다).
  const isVerdictKicker = density.kicker === RESULT_KICKER_LABEL;
  const verdictDotClass = isVerdictKicker
    ? density.verdictTone === 'success'
      ? 'bg-success'
      : density.verdictTone === 'destructive'
        ? 'bg-destructive'
        : 'bg-muted-foreground'
    : null;

  return (
    <div>
      {density.kicker ? (
        // story #3052(2984-S4) — MaterialChip(S1, 헤어라인+fill 0) 채택, bg-proof-blue-soft
        // 채움 폐지(§2 doc ⓒ kicker 판정 — 순수 SHIFT, 신호 아님).
        // story #5c29454b — 판정 dot(그래픽 신호, 텍스트는 계속 중립)을 chip 앞에 붙인다.
        <div className="mb-1.5 flex items-center gap-1.5">
          {verdictDotClass ? <span className={`size-1.5 shrink-0 rounded-full ${verdictDotClass}`} aria-hidden /> : null}
          <MaterialChip>{density.kicker}</MaterialChip>
        </div>
      ) : null}
      <p className={`mb-1.5 text-sm font-medium leading-relaxed [overflow-wrap:anywhere] ${density.kicker ? '' : 'mt-0'}`}>
        {density.lead}
      </p>
      {density.topLevelItems.length > 0 ? (
        <>
          <p className="mb-1 mt-2.5 text-[9.5px] font-bold uppercase tracking-wide text-muted-foreground">
            {t('reportEvidenceLabel')}
          </p>
          <ul className="mb-1.5 flex flex-col gap-0.5">
            {density.topLevelItems.map((item, i) => (
              <li key={i} className="text-sm leading-relaxed [overflow-wrap:anywhere]">{item.text}</li>
            ))}
          </ul>
        </>
      ) : null}
      {density.nextAction ? (
        // story #5c29454b — 「다음 행동」 존. 원문에 명시적 구분자(다음:/→ 다음/Next:)가
        // 있을 때만 뜬다(no-fiction — 지어낸 다음 행동 금지, computeReportDensity 참조).
        <div className="mt-2.5 flex gap-2 rounded-lg border border-brand/15 bg-brand/10 px-2.5 py-2">
          <span className="font-bold text-brand" aria-hidden>→</span>
          <p className="[overflow-wrap:anywhere]">
            <span className="font-semibold text-primary">{t('reportNextActionLabel')}</span>
            <span className="text-[12.5px] text-foreground"> {density.nextAction}</span>
          </p>
        </div>
      ) : null}
      <button
        type="button"
        onClick={() => setExpanded(true)}
        className="mt-1.5 text-[11.5px] font-semibold text-primary hover:underline"
      >
        {t('reportViewFull')}
      </button>
    </div>
  );
}
