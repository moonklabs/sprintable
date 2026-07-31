'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { UPCOMING_LIMIT, type EpicFlowNodeItem, type EpicFlowNodesResponse } from './derive-flow';
import {
  deriveFlowMapLane, parseDependencyGraphEdges, parseReferenceCandidateEdges,
  type FlowMapEdge, type FlowMapLane, type RawDependencyEdge, type RawReferenceCandidate,
} from './derive-flow-map';
import { FlowMapCanvas, type CreateLinkResult, type DeleteLinkResult } from './flow-map-canvas';
import { declareResponseToEdge } from './flow-port-linking';
import { parseCursorMeta } from '@/lib/pagination';

interface FlowEpicNodesProps {
  projectId: string;
  epicId: string;
  epicTitle: string;
  onSelectStory: (storyId: string) => void;
  /** story #2354 — 순수 통과 prop(FlowMapCanvas 참고). */
  selectedNodeId?: string | null;
}

type LoadState =
  | { kind: 'loading' }
  | { kind: 'error' }
  | { kind: 'ready'; data: EpicFlowNodesResponse; edges: FlowMapEdge[] };

function unwrap<T>(json: unknown): T | null {
  if (!json || typeof json !== 'object') return null;
  const d = (json as { data?: unknown }).data;
  return (d ?? json) as T;
}

interface RawStoryListPage {
  data: Array<{ id: string; story_number: number; title: string; status: string }>;
  meta: unknown;
}

/** 유나양 규격(아티팩트 a125909a, "누르면 펼쳐지는 것이 곧 줌인") — 묶음 카드를 누르면 이
 * 에픽의 done 스토리 «전부»를 가져온다(잘라내지 않는다, PO 판정 2026-07-30 — "많으니 미리
 * 잘라 두자는 안 하시는"). 페이지가 나뉘면(FE 프록시 `maxLimit:100`) cursor를 따라간다.
 *
 * ⛔`project_id`를 «일부러» 안 넣는다 — `status`+`project_id`를 같이 보내면 BE가 "board
 * 분기"(`list_board`)로 빠지는데, 그 분기가 `status==='done'`일 때 «최근 7일·최대 10건»을
 * 하드코딩으로 자른다(라이브 실측, 2026-07-30 — 오르테가군이 직접 겪은 offset 무시보다 한
 * 겹 더 나쁜 함정: 어떤 limit을 줘도 안 늘어난다). `project_id` 없이 `epic_id`+`status=done`
 * 만 보내면 그 분기를 안 타고 일반 `repo.list()` 경로로 가 그 제한이 없다(인가는
 * `_org_filter()`만으로 충분 — org 스코프가 SSOT라 project_id 생략이 인가 누수를 안 만드는
 * 것까지 코드로 확認했다, 2026-07-30). 이 주석 없이 project_id를 「빠뜨린 것 같다」며
 * 되돌리면 다시 깨진다 — 오르테가군이 명시로 짚은 자리.
 */
async function fetchAllDonePastItems(epicId: string): Promise<EpicFlowNodeItem[]> {
  const items: EpicFlowNodeItem[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 50; page += 1) { // 안전 상한(무한루프 방어) — 5000건 넘는 done은 오늘 없다.
    const params = new URLSearchParams({ epic_id: epicId, status: 'done', limit: '100' });
    if (cursor) params.set('cursor', cursor);
    const res = await fetch(`/api/stories?${params.toString()}`);
    if (!res.ok) break;
    const json: RawStoryListPage = await res.json();
    const rows = Array.isArray(json.data) ? json.data : [];
    for (const s of rows) {
      items.push({ id: s.id, story_number: s.story_number, title: s.title, status: s.status, assignee_id: null, updated_at: '' });
    }
    const page = parseCursorMeta(json.meta, 'FlowEpicNodes.fetchAllDonePastItems');
    if (!page.hasMore || !page.nextCursor) break;
    cursor = page.nextCursor;
  }
  return items;
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
export function FlowEpicNodes({ projectId, epicId, epicTitle, onSelectStory, selectedNodeId = null }: FlowEpicNodesProps) {
  const t = useTranslations('flow');
  const [state, setState] = useState<LoadState>({ kind: 'loading' });
  // 유나양 규격(아티팩트 a125909a) — 「펼침 상태」는 «묶음 단위»로 든다(오르테가군 지시:
  // "노드 단위로 들면 묶음이 안 서는" — 노드가 아니라 이 레인의 과거 묶음 «하나»가 펼쳐진
  // 상태를 표현). 오늘은 레인이 늘 하나(펼친 에픽 하나)라 컴포넌트 지역 상태로 충분하다.
  const [pastItems, setPastItems] = useState<EpicFlowNodeItem[]>([]);
  const [isPastBundleLoading, setIsPastBundleLoading] = useState(false);

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
    //
    // ⛔자가발견 결함(2026-07-30, PR#2709 "묶음이 선을 통과시킨다" 배포 후 재검토 중, hotfix
    // PR#2710로 해소) — "양끝 다 now/upcoming에 있는 것만" 미리 걸러내던 필터가 있으면 과거
    // (done) 스토리에 닿은 간선은 deriveFlowMapLane에 «도달하기도 전에» 사라진다. 분류(양끝
    // 살아있음/한쪽만/양끝 과거)는 deriveFlowMapLane 내부의 몫이라 여기서 미리 안 거른다.
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
      const edges = [...dependencyEdges, ...candidateEdges];
      setState({ kind: 'ready', data, edges });
    }).catch(() => {
      if (!cancelled) setState({ kind: 'error' });
    });
    return () => {
      cancelled = true;
    };
  }, [projectId, epicId, epicTitle]);

  // 에픽이 바뀌면(다른 행을 펼치면) 펼침 상태를 들고 가지 않는다 — 「이 묶음이 펼쳐졌나」는
  // 이 레인 소유라 다른 에픽으로 넘어가면 리셋되는 게 맞다. 별도 리셋 effect가 필요 없는
  // 이유: flow-canvas.tsx가 단일 아코디언(`isExpanded ? <FlowEpicNodes .../> : null`)이라
  // 다른 행을 펼치면 이 컴포넌트«전체»가 언마운트→새 마운트된다 — `epicId`가 이미 마운트된
  // 채로 바뀌는 경우 자체가 없다(pastItems 초기값 `[]`가 항상 새 마운트의 값).
  const handleTogglePastBundle = useCallback(() => {
    if (pastItems.length > 0) {
      setPastItems([]); // 다시 누르면 접힌다(유나양 규격 그대로).
      return;
    }
    setIsPastBundleLoading(true);
    fetchAllDonePastItems(epicId)
      .then((items) => setPastItems(items))
      .finally(() => setIsPastBundleLoading(false));
  }, [epicId, pastItems.length]);

  // story #2353(AC14) — 낙관적 업데이트 금지. 서버가 201/200을 준 «뒤»에만 edges를 갱신한다
  // (FlowMapCanvas는 이 state.edges를 직접 그리므로, 여기서 안 바꾸면 화면도 안 바뀐다 —
  // "서버가 받은 뒤에 선이 선다"가 자연히 성립하는 자리).
  const handleCreateLink = useCallback(async (params: { apiSourceId: string; targetId: string; relationKind: string | null }): Promise<CreateLinkResult> => {
    try {
      const res = await fetch(`/api/stories/${params.apiSourceId}/reference-candidates`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ target_id: params.targetId, relation_kind: params.relationKind }),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok) {
        // AC15 — 서버가 준 원문 그대로. 새로 진단 문장을 짓지 않는다.
        return { ok: false, error: typeof json?.detail === 'string' ? json.detail : t('portLinkErrorFallback') };
      }
      const edge = declareResponseToEdge(params.apiSourceId, {
        target_id: json.target_id, relation_kind: json.relation_kind, status: json.status,
      });
      setState((prev) => (prev.kind === 'ready' ? { ...prev, edges: [...prev.edges, { ...edge, candidateId: json.id, declaredBy: json.declared_by, declaredAt: json.declared_at }] } : prev));
      return { ok: true };
    } catch {
      return { ok: false, error: t('portLinkErrorFallback') };
    }
  }, [t]);

  const handleDeleteLink = useCallback(async (candidateId: string, anchorStoryId: string): Promise<DeleteLinkResult> => {
    try {
      // {id}는 BE(stories.py undeclare_story_reference_candidate)가 project access 확認
      // 앵커로만 쓴다(candidate_id 자체는 org 스코프로 별도 조회) — 그래도 실재하는 story
      // id여야 한다(repo.get(id) 404 체크가 있다). epicId는 goal(에픽) id라 여기 못 쓴다 —
      // 호출부(FlowMapCanvas)가 지운 간선의 실제 endpoint story id(anchorStoryId)를 넘긴다.
      const res = await fetch(`/api/stories/${anchorStoryId}/reference-candidates/${candidateId}`, { method: 'DELETE' });
      if (!res.ok) {
        const json = await res.json().catch(() => null);
        return { ok: false, error: typeof json?.detail === 'string' ? json.detail : t('portLinkErrorFallback') };
      }
      setState((prev) => (prev.kind === 'ready' ? { ...prev, edges: prev.edges.filter((e) => e.candidateId !== candidateId) } : prev));
      return { ok: true };
    } catch {
      return { ok: false, error: t('portLinkErrorFallback') };
    }
  }, [t]);

  const lane: FlowMapLane | null = useMemo(() => {
    if (state.kind !== 'ready') return null;
    return deriveFlowMapLane(
      epicId, epicTitle, state.data.past.total, state.data.now.items, state.data.upcoming.items,
      state.edges, pastItems,
    );
  }, [state, pastItems, epicId, epicTitle]);

  if (state.kind === 'loading') {
    return <p className="px-2 py-2 text-[11px] text-muted-foreground">{t('nodesLoading')}</p>;
  }
  if (state.kind === 'error' || !lane) {
    return <p className="px-2 py-2 text-[11px] text-muted-foreground">{t('nodesError')}</p>;
  }

  return (
    <FlowMapCanvas
      lanes={[lane]}
      onSelectStory={onSelectStory}
      onTogglePastBundle={handleTogglePastBundle}
      isPastBundleLoading={isPastBundleLoading}
      selectedNodeId={selectedNodeId}
      onCreateLink={handleCreateLink}
      onDeleteLink={handleDeleteLink}
    />
  );
}
