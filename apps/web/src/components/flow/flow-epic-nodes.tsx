'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { deriveFlowNodeZones, UPCOMING_LIMIT, type EpicFlowNodesResponse, type FlowNodeZones } from './derive-flow';
import { FlowNodeCard } from './flow-node-card';

interface FlowEpicNodesProps {
  projectId: string;
  epicId: string;
}

type LoadState =
  | { kind: 'loading' }
  | { kind: 'error' }
  | { kind: 'ready'; zones: FlowNodeZones };

function unwrap(json: unknown): EpicFlowNodesResponse | null {
  if (!json || typeof json !== 'object') return null;
  const d = (json as { data?: unknown }).data;
  return (d ?? json) as EpicFlowNodesResponse;
}

/**
 * 노드 틀(story #2224 후속, 2026-07-30) — 접힌 레인/캔버스 행을 펼치면 이 컴포넌트가 뜬다.
 * `?epic_id=` 단위 온디맨드 fetch(까심 PR#2679 계약) — 179 에픽 전체를 한 번에 부르면
 * 죽는다는 PO 판정에 따라 펼친 에픽 하나만 부른다. `upcoming_limit`은 BE 기본값(15)에
 * 기대지 않고 화면이 명시로 넣는다(PO 2026-07-30 — "화면이 몇 개를 감당하는지는 화면만 안다").
 */
export function FlowEpicNodes({ projectId, epicId }: FlowEpicNodesProps) {
  const t = useTranslations('flow');
  const [state, setState] = useState<LoadState>({ kind: 'loading' });

  useEffect(() => {
    // 초기 state가 이미 loading이고, 이 컴포넌트는 항상 epicId별로 새로 마운트되므로(부모가
    // FlowCanvas에서 조건부 렌더 — 다른 행이 펼쳐지면 이 인스턴스 자체가 언마운트/재마운트된다,
    // "상세페이지 key-remount" 표준과 동형) effect 안에서 loading으로 재설정할 필요가 없다.
    let cancelled = false;
    fetch(`/api/v2/analytics/epic-flow-nodes?project_id=${projectId}&epic_id=${epicId}&upcoming_limit=${UPCOMING_LIMIT}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((json: unknown) => {
        if (cancelled) return;
        const data = unwrap(json);
        if (!data) {
          setState({ kind: 'error' });
          return;
        }
        setState({ kind: 'ready', zones: deriveFlowNodeZones(data) });
      })
      .catch(() => {
        if (!cancelled) setState({ kind: 'error' });
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, epicId]);

  if (state.kind === 'loading') {
    return <p className="px-2 py-2 text-[11px] text-muted-foreground">{t('nodesLoading')}</p>;
  }
  if (state.kind === 'error') {
    return <p className="px-2 py-2 text-[11px] text-muted-foreground">{t('nodesError')}</p>;
  }

  const { zones } = state;

  return (
    <div className="space-y-3 rounded-md border border-dashed border-border p-2">
      <section className="space-y-1">
        <p className="text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
          {t('canvasPast')} · {zones.pastTotal}
        </p>
        {/* past.items 필드가 계약 스키마에 없다 — 노드로 못 그린다(타입이 강제, derive-flow.ts 참조). */}
      </section>

      <section className="space-y-1">
        <p className="text-[10px] font-semibold uppercase tracking-[0.08em] text-info">
          {t('canvasNow')} · {zones.nowTotal}
        </p>
        {zones.nowItems.length === 0 ? (
          <p className="px-1 text-[11px] text-muted-foreground">{t('nodesNowEmpty')}</p>
        ) : (
          <ul className="space-y-1">
            {zones.nowItems.map((item) => (
              <FlowNodeCard key={item.id} item={item} />
            ))}
          </ul>
        )}
      </section>

      <section className="space-y-1">
        <p className="text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
          {t('canvasUpcoming')} · {t('nodesUpcomingCount', { shown: zones.upcomingShown, total: zones.upcomingTotal })}
        </p>
        {zones.upcomingItems.length === 0 ? (
          <p className="px-1 text-[11px] text-muted-foreground">{t('nodesUpcomingEmpty')}</p>
        ) : (
          <ul className="space-y-1">
            {zones.upcomingItems.map((item) => (
              <FlowNodeCard key={item.id} item={item} />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
