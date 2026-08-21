'use client';

import { useEffect, useState } from 'react';
import { ChevronDown, ChevronUp, ShieldCheck } from 'lucide-react';
import { EmbedCard } from './embed-card';
import { ApprovalRequestCard } from './approval-request-card';
import type { GateItem } from '@/components/kanban/types';
import { fetchWithAuth } from '@/lib/db/client';
import type { ReadingPanelTarget } from './reading-panel';
import type { EventDefinitionSummary } from '@/lib/block-template';
import { toEmbedCardOpenPanel } from './embed-card-open-panel-adapter';

// story #2905(S2c③④) — delta 시안(`s2c-delta-grouping-states`) §② collapsed/expanded 상태.
// «풍부하되 격납» 불변식 재확認: 여럿=격납이 default, 헤더가 개수/성격 요약, 펼침은 사용자 액션.
const LIST_DEFAULT_VISIBLE = 3;

export interface EmbedGroupProps {
  entityType: string;
  refs: Array<{ entityId: string; label: string }>;
  onOpenReadingPanel?: (target: ReadingPanelTarget) => void;
  eventDefinitionsByKey?: Record<string, EventDefinitionSummary> | null;
}

/**
 * gate 그룹 — 접힘 기본 「결재 대기 N건」(세로 벽 방지) → 펼치면 각 gate =
 * ApprovalRequestCard(§②·원탭+마찰, 사본 분화 금지 재사용). **헤더 라벨 정직성**(delta §②
 * ⚠️): pending/resolved 섞이면 N은 pending만 세지 않고 「결재 N건 · 대기 M건」으로 전체와
 * 대기를 함께 밝힌다 — 거짓 라벨(오래된 대기 수 방치) 금지.
 */
function GateGroup({ refs, eventDefinitionsByKey }: { refs: EmbedGroupProps['refs']; eventDefinitionsByKey?: Record<string, EventDefinitionSummary> | null }) {
  const [expanded, setExpanded] = useState(false);
  const [statuses, setStatuses] = useState<Record<string, string> | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const entries = await Promise.all(
        refs.map(async (r) => {
          try {
            const res = await fetchWithAuth(`/api/gates/${r.entityId}`);
            if (!res.ok) return [r.entityId, null] as const;
            const json = (await res.json().catch(() => null)) as { data?: GateItem } | GateItem | null;
            const gate = (json && 'data' in json ? json.data : json) as GateItem | undefined;
            return [r.entityId, gate?.status ?? null] as const;
          } catch {
            return [r.entityId, null] as const;
          }
        }),
      );
      if (!cancelled) {
        setStatuses(Object.fromEntries(entries.filter(([, s]) => s !== null)) as Record<string, string>);
      }
    })();
    return () => { cancelled = true; };
  }, [refs]);

  const total = refs.length;
  const known = statuses ? Object.values(statuses) : [];
  const pendingCount = known.filter((s) => s === 'pending').length;
  // fetch 완료 전(statuses===null)이거나 일부만 확認됐으면 "결재 대기"로 단정하지 않는다 —
  // 아직 모르는 걸 안다고 말하지 않는다(정직 라벨 원칙, [[feedback-verify-claim-needs-exact-command]]와 같은 결).
  const headerLabel = statuses === null
    ? `게이트 ${total}건`
    : pendingCount === total
      ? `결재 대기 ${pendingCount}건`
      : `결재 ${total}건 · 대기 ${pendingCount}건`;

  return (
    <div className="rounded-lg border border-border bg-muted/20">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm font-medium text-foreground transition hover:bg-muted/40"
      >
        <ShieldCheck className="size-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate">{headerLabel}</span>
        {expanded ? <ChevronUp className="size-4 shrink-0 text-muted-foreground" /> : <ChevronDown className="size-4 shrink-0 text-muted-foreground" />}
      </button>
      {expanded && (
        <div className="space-y-2 border-t border-border p-2">
          {refs.map((r) => (
            <ApprovalRequestCard
              key={r.entityId}
              target={{ work_item_type: '', work_item_id: '', gate_id: r.entityId }}
              eventDefinitionsByKey={eventDefinitionsByKey}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/** artifact 그룹 — «가로 슬라이드 캐러셀»(§3 표: 썸네일/미리보기가 값을 갖는 여럿). 각 항목은
 * EmbedCard(artifact)를 그대로 재사용(S2c① 실 렌더 인라인 로직·사본 0) — 고정폭 열로 늘어놓고
 * overflow-x-auto로 스크롤(1스크린 자연 노출 + 나머지는 옆으로). object→5-인자 어댑터는
 * embed-card-open-panel-adapter.ts SSOT(chat-bubble.tsx `p` 핸들러와 진짜 같은 참조 — 카디르
 * QA #3319 지적 반영, 각자 로컬 구현 드리프트 제거). */
function ArtifactCarousel({ refs, onOpenReadingPanel }: { refs: EmbedGroupProps['refs']; onOpenReadingPanel?: EmbedGroupProps['onOpenReadingPanel'] }) {
  const openPanel = toEmbedCardOpenPanel(onOpenReadingPanel);
  return (
    <div className="flex gap-2 overflow-x-auto pb-1">
      {refs.map((r) => (
        <div key={r.entityId} className="w-40 shrink-0">
          <EmbedCard entity_type="artifact" entity_id={r.entityId} title={r.label} status={null} onOpenReadingPanel={openPanel} />
        </div>
      ))}
    </div>
  );
}

/** 텍스트류(story/task/doc/epic/sprint/hypothesis/evidence) — «간결 리스트»(§3 표: 상태·시각
 * 약한 텍스트 레코드 여럿). default 3행 + 「+N 더보기」 → 펼치면 전체 + 「접기」. 각 행은
 * EmbedCard(비-artifact 폼 = 아이콘+라벨+상태 압축 pill)를 그대로 재사용. */
function ConciseList({ entityType, refs, onOpenReadingPanel }: { entityType: string; refs: EmbedGroupProps['refs']; onOpenReadingPanel?: EmbedGroupProps['onOpenReadingPanel'] }) {
  const [expanded, setExpanded] = useState(false);
  const visible = expanded ? refs : refs.slice(0, LIST_DEFAULT_VISIBLE);
  const hiddenCount = refs.length - LIST_DEFAULT_VISIBLE;
  const openPanel = toEmbedCardOpenPanel(onOpenReadingPanel);

  return (
    <div className="space-y-1.5">
      {visible.map((r) => (
        <EmbedCard key={r.entityId} entity_type={entityType} entity_id={r.entityId} title={r.label} status={null} onOpenReadingPanel={openPanel} />
      ))}
      {hiddenCount > 0 && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="text-xs font-medium text-primary hover:underline"
        >
          {expanded ? '접기' : `+${hiddenCount} 더보기`}
        </button>
      )}
    </div>
  );
}

export function EmbedGroup({ entityType, refs, onOpenReadingPanel, eventDefinitionsByKey }: EmbedGroupProps) {
  if (entityType === 'gate') return <GateGroup refs={refs} eventDefinitionsByKey={eventDefinitionsByKey} />;
  if (entityType === 'artifact') return <ArtifactCarousel refs={refs} onOpenReadingPanel={onOpenReadingPanel} />;
  return <ConciseList entityType={entityType} refs={refs} onOpenReadingPanel={onOpenReadingPanel} />;
}
