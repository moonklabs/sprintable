'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import type { ChatMessage } from '@/hooks/use-chat-sse';
import type { EntityStatusFetchState } from './entity-status-labels';
import type { ReadingPanelTarget } from './reading-panel';
import type { EventDefinitionSummary } from '@/lib/block-template';
import { ChatMarkdown } from './chat-bubble';
import { computeReportDensity } from '@/lib/chat-report-density';

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

  return (
    <div>
      {density.kicker ? (
        <span className="mb-1.5 inline-flex items-center gap-1 rounded-md bg-proof-blue-soft px-2 py-0.5 text-[10px] font-bold text-proof-blue">
          {density.kicker}
        </span>
      ) : null}
      <p className={`mb-1.5 text-sm font-medium leading-relaxed [overflow-wrap:anywhere] ${density.kicker ? '' : 'mt-0'}`}>
        {density.lead}
      </p>
      {density.topLevelItems.length > 0 ? (
        <ul className="mb-1.5 flex flex-col gap-0.5">
          {density.topLevelItems.map((item, i) => (
            <li key={i} className="text-sm leading-relaxed [overflow-wrap:anywhere]">{item.text}</li>
          ))}
        </ul>
      ) : null}
      <button
        type="button"
        onClick={() => setExpanded(true)}
        className="text-[11.5px] font-semibold text-primary hover:underline"
      >
        {t('reportViewFull')}
      </button>
    </div>
  );
}
