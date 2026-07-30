'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { UPCOMING_LIMIT, type EpicFlowNodesResponse } from './derive-flow';
import { deriveFlowMapLane, type FlowMapLane } from './derive-flow-map';
import { FlowMapCanvas } from './flow-map-canvas';

interface FlowEpicNodesProps {
  projectId: string;
  epicId: string;
  epicTitle: string;
}

type LoadState =
  | { kind: 'loading' }
  | { kind: 'error' }
  | { kind: 'ready'; lane: FlowMapLane };

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
 *
 * L3 지도(유나 목업 `be8709a4`, PO 판정) — 펼친 에픽 하나를 `lanes: FlowMapLane[]`(길이 1)로
 * 감싸 FlowMapCanvas에 넘긴다. 멀티레인 BE 계약이 착지하면 호출부가 여러 에픽을 fetch해
 * 배열을 채우는 것으로 끝난다(이 컴포넌트/FlowMapCanvas 모두 무변경).
 */
export function FlowEpicNodes({ projectId, epicId, epicTitle }: FlowEpicNodesProps) {
  const t = useTranslations('flow');
  const [state, setState] = useState<LoadState>({ kind: 'loading' });

  useEffect(() => {
    let cancelled = false;
    // 결함 fix(2026-07-30, 라이브 픽셀 검증 중 발견) — `/api/v2/...`는 백엔드 원본 경로
    // 패턴이지 FE가 브라우저에서 직접 부를 상대경로가 아니다(401 Missing Authorization
    // header로 실패했다, 직접 실측). 다른 모든 엔드포인트처럼 FE 프록시 라우트
    // (`/api/analytics/epic-flow-nodes/route.ts`)를 거쳐야 인증 토큰이 실린다.
    fetch(`/api/analytics/epic-flow-nodes?project_id=${projectId}&epic_id=${epicId}&upcoming_limit=${UPCOMING_LIMIT}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((json: unknown) => {
        if (cancelled) return;
        const data = unwrap(json);
        if (!data) {
          setState({ kind: 'error' });
          return;
        }
        // #2221(구조화된 연결 간선) 미착지 — edges는 항상 빈 배열. computeNodeDepth가 이
        // 빈 배열을 받아 «자연히» 전부 depth 0을 내는 것이라, 이 자리에서 특수분기를 두지
        // 않는다(간선이 착지하면 이 한 줄이 실 배열로 바뀌는 것만으로 여러 열이 열린다).
        const lane = deriveFlowMapLane(epicId, epicTitle, data.past.total, data.now.items, data.upcoming.items, []);
        setState({ kind: 'ready', lane });
      })
      .catch(() => {
        if (!cancelled) setState({ kind: 'error' });
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, epicId, epicTitle]);

  if (state.kind === 'loading') {
    return <p className="px-2 py-2 text-[11px] text-muted-foreground">{t('nodesLoading')}</p>;
  }
  if (state.kind === 'error') {
    return <p className="px-2 py-2 text-[11px] text-muted-foreground">{t('nodesError')}</p>;
  }

  return <FlowMapCanvas lanes={[state.lane]} />;
}
