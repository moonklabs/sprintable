'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { UPCOMING_LIMIT, type EpicFlowNodesResponse } from './derive-flow';
import {
  deriveFlowMapLane, parseDependencyGraphEdges, parseReferenceCandidateEdges,
  type FlowMapLane, type RawDependencyEdge, type RawReferenceCandidate,
} from './derive-flow-map';
import { FlowMapCanvas } from './flow-map-canvas';

interface FlowEpicNodesProps {
  projectId: string;
  epicId: string;
  epicTitle: string;
  onSelectStory: (storyId: string) => void;
}

type LoadState =
  | { kind: 'loading' }
  | { kind: 'error' }
  | { kind: 'ready'; lane: FlowMapLane };

function unwrap<T>(json: unknown): T | null {
  if (!json || typeof json !== 'object') return null;
  const d = (json as { data?: unknown }).data;
  return (d ?? json) as T;
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
export function FlowEpicNodes({ projectId, epicId, epicTitle, onSelectStory }: FlowEpicNodesProps) {
  const t = useTranslations('flow');
  const [state, setState] = useState<LoadState>({ kind: 'loading' });

  useEffect(() => {
    let cancelled = false;
    // 결함 fix(2026-07-30, 라이브 픽셀 검증 중 발견) — `/api/v2/...`는 백엔드 원본 경로
    // 패턴이지 FE가 브라우저에서 직접 부를 상대경로가 아니다(401 Missing Authorization
    // header로 실패했다, 직접 실측). 다른 모든 엔드포인트처럼 FE 프록시 라우트
    // (`/api/analytics/epic-flow-nodes/route.ts`)를 거쳐야 인증 토큰이 실린다.
    //
    // 선생님 지시(2026-07-30, P0) — "edges=[]를 항상 넘긴다"(하드코딩)와 "받았는데 0건"은
    // 다른 사실이다. 기존 계획형 `dependencies/graph`를 실제로 fetch한다(org 전체가 0행이라
    // 오늘은 결과가 똑같이 빈 배열이겠지만, «받으러 갔다»는 사실 자체가 다르다). item_id
    // 없이 `item_type=story`만 넘겨 프로젝트 전체 그래프를 받고 이 에픽의 노드 id로 필터링
    // — 실 데이터가 쌓이면(org 스케일) item_id 배치 조회로 좁혀야 한다(오늘은 0행이라 무해).
    //
    // 오르테가군 확定(2026-07-30, PR#2701 배포 후 라이브 실측으로 발견) — 화면이 보던
    // `dependencies`(계획형, 0행)와 디디군이 백필한 실 재료 `reference_semantic_candidates`
    // (1321건)는 «다른 표»라 앞의 fetch만으로는 실 후보가 안 왔다. 까심군 벌크 엔드포인트
    // (`/api/goals/{id}/reference-candidates`, PR#2704)를 추가로 부른다 — 응답은 BE 원시
    // 어휘 그대로(래핑 없음, `dependencies/graph`와 같은 plain-array 패턴)라 `unwrap` 안 씀.
    // 두 출처를 `parseReferenceCandidateEdges`/`parseDependencyGraphEdges`로 각각 정규화한
    // 뒤 하나의 FlowMapEdge[] 로 합친다 — 렌더 레이어(FlowMapCanvas)는 출처를 모른다.
    // 실패해도 전체를 죽이지 않는다(간선은 보강 정보, 노드가 핵심 — 부분 실패는 부분만 표시).
    Promise.all([
      fetch(`/api/analytics/epic-flow-nodes?project_id=${projectId}&epic_id=${epicId}&upcoming_limit=${UPCOMING_LIMIT}`)
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null),
      fetch('/api/dependencies/graph?item_type=story')
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null),
      fetch(`/api/goals/${epicId}/reference-candidates`)
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null),
    ]).then(([nodesJson, graphJson, candidatesJson]) => {
      if (cancelled) return;
      const data = unwrap<EpicFlowNodesResponse>(nodesJson);
      if (!data) {
        setState({ kind: 'error' });
        return;
      }
      const graph = unwrap<{ edges: RawDependencyEdge[] }>(graphJson);
      const dependencyEdges = parseDependencyGraphEdges(graph?.edges ?? []);
      const rawCandidates: RawReferenceCandidate[] = Array.isArray(candidatesJson) ? candidatesJson : [];
      const candidateEdges = parseReferenceCandidateEdges(rawCandidates);
      // ⛔자가발견 결함(2026-07-30, PR#2709 "묶음이 선을 통과시킨다" 배포 후 재검토 중) —
      // "양끝 다 now/upcoming(=살아있음)에 있는 것만" 미리 걸러내던 이 필터가 있으면, 과거
      // (done) 스토리에 닿은 간선은 deriveFlowMapLane에 «도달하기도 전에» 사라진다. 즉
      // PR#2709의 묶음-해소 로직(양끝 살아있음/한쪽만 과거/양끝 과거 3분류)이 볼 재료 자체가
      // 없어져 그 PR 전체가 라이브에서 죽은 코드가 되는 구조였다 — 분류는 이제
      // deriveFlowMapLane 내부의 몫이라 여기서 미리 걸러내지 않는다. 원시 edges를 그대로 넘긴다.
      const edges = [...dependencyEdges, ...candidateEdges];
      const lane = deriveFlowMapLane(epicId, epicTitle, data.past.total, data.now.items, data.upcoming.items, edges);
      setState({ kind: 'ready', lane });
    }).catch(() => {
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

  return <FlowMapCanvas lanes={[state.lane]} onSelectStory={onSelectStory} />;
}
