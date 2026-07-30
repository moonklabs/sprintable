'use client';

import { useTranslations } from 'next-intl';
import type { EpicFlowNodeItem } from './derive-flow';

// "지금"이 in-progress+in-review만 오는 계약이라 실제로는 이 두 값만 보이지만, ready-for-dev/
// blocked/backlog/done도 미래에 다른 구역이 그 상태들을 재사용할 수 있어 라벨을 전부 준비해
// 둔다 — 없는 키를 만나면 item.status 원문을 그대로 보여준다(지어낸 라벨 없음).
const STATUS_LABEL_KEY: Record<string, string> = {
  'in-progress': 'nodeStatusInProgress',
  'in-review': 'nodeStatusInReview',
  'ready-for-dev': 'nodeStatusReadyForDev',
  blocked: 'nodeStatusBlocked',
  backlog: 'nodeStatusBacklog',
  done: 'nodeStatusDone',
};

/** 노드 카드 — 유나 규격(2026-07-30): 노드는 전부 "작업"이라 테두리 있는 상자(자료=테두리 없는
 * 칩과 다른 축). 구역(지금/이어질)과 상태(뱃지)를 섞지 않는다 — 구역은 이 컴포넌트를 담는
 * 부모(FlowCanvas)가 결정하고, 이 카드는 상태만 뱃지로 보인다. */
export function FlowNodeCard({ item }: { item: EpicFlowNodeItem }) {
  const t = useTranslations('flow');
  const statusKey = STATUS_LABEL_KEY[item.status];

  return (
    <li className="rounded-md border border-border bg-background px-2 py-1.5 text-[11px]">
      <div className="flex items-center justify-between gap-2">
        <span className="min-w-0 truncate text-foreground">
          #{item.story_number} {item.title}
        </span>
        <span className="shrink-0 rounded-full border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground">
          {statusKey ? t(statusKey) : item.status}
        </span>
      </div>
    </li>
  );
}
