'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Loader2 } from 'lucide-react';
import { UPCOMING_LIMIT, type EpicFlowNodeItem, type EpicFlowNodesResponse } from './derive-flow';
import {
  deriveFlowMapLane, parseDependencyGraphEdges, parseReferenceCandidateEdges,
  type FlowMapEdge, type RawDependencyEdge, type RawReferenceCandidate,
} from './derive-flow-map';
import { FlowMapCanvas, FlowCanvasOffscreenHint, HEADER_HEIGHT, NODE_ROW_HEIGHT, LANE_MIN_HEIGHT, type CreateLinkResult, type DeleteLinkResult, type RejectLinkResult } from './flow-map-canvas';
import { FlowCanvasResizePane } from './flow-canvas-resize-pane';
import { declareResponseToEdge } from './flow-port-linking';
import type { NextMakerGoal } from './derive-next-maker';
import { parseCursorMeta } from '@/lib/pagination';
import { useOrgSyncVersion } from '@/lib/project-context-client';

interface FlowMultiLaneCanvasProps {
  projectId: string;
  /** story #2224 AC1 — 30일 안에 변화가 있었던 목표들. 이 컴포넌트가 각자의 레인을
   * 병렬로 fetch해 하나의 캔버스에 쌓는다(FlowMapCanvas는 이미 `lanes: FlowMapLane[]`을
   * 받도록 지어져 있었다 — "멀티레인이 오면 배열 길이만 늘린다"던 그 자리). */
  expandGoals: NextMakerGoal[];
  /** 접힌(30일 안 변화 없음) 목표 수 — 하단 접힘 줄의 재료. 목업 그대로: "숨긴 것이 아니라
   * 접은 것입니다". */
  foldedCount: number;
  onSelectStory: (storyId: string) => void;
  selectedNodeId?: string | null;
  /** story #2353 되돌리기 다이얼로그의 「{이름}이 만든 연결입니다」 이름 조회용(goal-stem-card.tsx
   * 참고 — 새 fetch 아님, 호출부가 이미 들고 있는 값을 그대로 흘려보낸다). */
  memberMap?: Record<string, { name: string }>;
  /** story #2535(E-FLOW-V4 S5) — 드릴다운 착지점. 순수 통과(FlowMapCanvas가 실제 스크롤+
   * 하이라이트를 한다, next-maker-screen.tsx 문서 참고). */
  focusGoalId?: string | null;
}

interface RawStoryListPage {
  data: Array<{ id: string; story_number: number; title: string; status: string }>;
  meta: unknown;
}

// flow-epic-nodes.tsx의 fetchAllDonePastItems와 동형 — 묶음 카드를 펼치면 그 목표의 done
// 스토리 전부를 가져온다. project_id를 «일부러» 안 넣는 이유도 동일(board 분기의 「최근
// 7일·최대 10건」 하드코딩을 피한다, flow-epic-nodes.tsx 문서 참고).
async function fetchAllDonePastItems(epicId: string): Promise<EpicFlowNodeItem[]> {
  const items: EpicFlowNodeItem[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 50; page += 1) {
    const params = new URLSearchParams({ epic_id: epicId, status: 'done', limit: '100' });
    if (cursor) params.set('cursor', cursor);
    const res = await fetch(`/api/stories?${params.toString()}`);
    if (!res.ok) break;
    const json: RawStoryListPage = await res.json();
    const rows = Array.isArray(json.data) ? json.data : [];
    for (const s of rows) {
      items.push({ id: s.id, story_number: s.story_number, title: s.title, status: s.status, assignee_id: null, updated_at: '' });
    }
    const page = parseCursorMeta(json.meta, 'FlowMultiLaneCanvas.fetchAllDonePastItems');
    if (!page.hasMore || !page.nextCursor) break;
    cursor = page.nextCursor;
  }
  return items;
}

function unwrap<T>(json: unknown): T | null {
  if (!json || typeof json !== 'object') return null;
  const d = (json as { data?: unknown }).data;
  return (d ?? json) as T;
}

/** 레인 하나를 다시 그리는 데 필요한 «원재료»— fetch는 한 번, 파생(deriveFlowMapLane)은
 * pastItems가 바뀔 때마다 «다시»(순수함수라 값싸다). 이미 파생된 FlowMapLane 위에 pastNodes
 * 필드만 덮어씌우면 안 된다 — 과거를 펼쳤을 때의 좌표·간선(computeNodePositions의
 * 'past-expanded' 열)은 deriveFlowMapLane 내부에서 함께 계산되므로, 재료부터 다시 태워야
 * 좌표와 간선이 실제로 맞는다. */
interface LaneIngredients {
  epicTitle: string;
  data: EpicFlowNodesResponse;
  edges: FlowMapEdge[];
}

async function fetchLaneIngredients(
  projectId: string, epicId: string, epicTitle: string, sharedDependencyEdges: FlowMapEdge[],
): Promise<LaneIngredients | null> {
  const [nodesJson, candidatesJson] = await Promise.all([
    fetch(`/api/analytics/epic-flow-nodes?project_id=${projectId}&epic_id=${epicId}&upcoming_limit=${UPCOMING_LIMIT}`)
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null),
    fetch(`/api/goals/${epicId}/reference-candidates`)
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null),
  ]);
  const data = unwrap<EpicFlowNodesResponse>(nodesJson);
  if (!data) return null;
  const rawCandidates: RawReferenceCandidate[] = Array.isArray(candidatesJson) ? candidatesJson : [];
  const candidateEdges = parseReferenceCandidateEdges(rawCandidates);
  const edges = [...sharedDependencyEdges, ...candidateEdges];
  return { epicTitle, data, edges };
}

type LoadState =
  | { kind: 'loading' }
  | { kind: 'error' }
  | { kind: 'ready'; ingredientsByEpic: Map<string, LaneIngredients> };

/**
 * story #2224 AC1(2026-07-31, 목업 84abdf43 v5 "팀의 흐름이 한눈에") — 갈래 캔버스의 본체.
 * 목표 «하나»를 골라 그 레인만 보던 것(GoalStemCard+FlowEpicNodes, 여전히 다른 화면에서
 * 유효)을 대체 — 30일 안에 움직인 목표들을 «전부» 레인으로 동시에 쌓는다. 목표와 목표
 * 사이의 굵은 선(goal-edges)은 BE `/analytics/goal-edges`(PR#2726, 디디군 작업)가 서야
 * 그려진다 — 그 전까지는 자리만 비워 둔다(PO 지시 "이번 판에 안 그린다").
 *
 * `dependencies/graph`는 프로젝트 전체 그래프라 레인마다 다시 안 부른다(레인 수만큼 같은
 * 요청을 반복하면 §I-6 "두 벌 서지 않는다"를 레인 축으로 어기는 것) — 한 번만 fetch해 모든
 * 레인에 그대로 태운다(관련 없는 edge는 deriveFlowMapLane이 알아서 못 그린다, 기존 단일-레인
 * 컴포넌트와 같은 안전성).
 */
export function FlowMultiLaneCanvas({
  projectId, expandGoals, foldedCount, onSelectStory, selectedNodeId = null, memberMap = {}, focusGoalId = null,
}: FlowMultiLaneCanvasProps) {
  const t = useTranslations('flow');
  const [state, setState] = useState<LoadState>({ kind: 'loading' });
  const [pastItemsByEpic, setPastItemsByEpic] = useState<Map<string, EpicFlowNodeItem[]>>(new Map());
  const [loadingPastBundleEpicIds, setLoadingPastBundleEpicIds] = useState<Set<string>>(new Set());
  // story #2369 QA 후속(2026-07-31) — FlowMapCanvas가 세는 오프스크린(가로 잘림) 수를 여기로
  // 끌어올린다. FlowCanvasResizePane이 세로로 «실제 클리핑하는» 유일한 조상이라, 힌트는
  // FlowMapCanvas 안이 아니라 그 조상의 «보이는 창» 기준(overlay prop)으로 그려야 항상
  // 보인다(위 FlowCanvasResizePane/FlowMapCanvas 문서 참고).
  const [offscreenCardCount, setOffscreenCardCount] = useState(0);

  const expandGoalIds = useMemo(() => expandGoals.map((g) => g.id).join(','), [expandGoals]);
  // story #2545(카디르 라이브 재QA 3단계) — org 불일치 자동교정(switch-org)이 이 fetch 直後
  // 성공하면 project/expandGoals는 안 바뀌므로 재요청 트리거가 없었다(/flow의 실제 goals
  // 요청원 — GoalsClient/goals-client.tsx가 아니라 이 컴포넌트의 fetchLaneIngredients였다,
  // 카디르 grep으로 특定). project-context-client.ts 참고.
  const orgSyncVersion = useOrgSyncVersion();

  useEffect(() => {
    let cancelled = false;
    setState({ kind: 'loading' });
    void (async () => {
      const graphJson = await fetch('/api/dependencies/graph?item_type=story')
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null);
      const graph = unwrap<{ edges: RawDependencyEdge[] }>(graphJson);
      const sharedDependencyEdges = parseDependencyGraphEdges(graph?.edges ?? []);

      const results = await Promise.all(
        expandGoals.map((g) => fetchLaneIngredients(projectId, g.id, g.title, sharedDependencyEdges)),
      );
      if (cancelled) return;
      const ingredientsByEpic = new Map<string, LaneIngredients>();
      expandGoals.forEach((g, i) => {
        const ing = results[i];
        if (ing) ingredientsByEpic.set(g.id, ing);
      });
      setState({ kind: 'ready', ingredientsByEpic });
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- expandGoals identity churns every parent render; expandGoalIds(문자열)가 실제 트리거다. orgSyncVersion도 콜백 안에서 안 읽는 의도적 invalidation 트리거(story #2545).
  }, [projectId, expandGoalIds, orgSyncVersion]);

  // story #2224(멀티레인) — 어느 레인의 묶음인지 FlowMapCanvas가 epicId를 실어 보낸다.
  // 이미 펼쳐져 있으면(pastItemsByEpic에 항목 있음) 접고 끝 — 아니면 fetch해서 편다
  // (flow-epic-nodes.tsx의 단일-레인 판과 같은 두 갈래, 레인 식별자만 더해졌다).
  const handleTogglePastBundle = useCallback((epicId: string) => {
    const alreadyExpanded = (pastItemsByEpic.get(epicId)?.length ?? 0) > 0;
    if (alreadyExpanded) {
      setPastItemsByEpic((prev) => {
        const next = new Map(prev);
        next.delete(epicId); // 다시 누르면 접힌다.
        return next;
      });
      return;
    }
    setLoadingPastBundleEpicIds((prev) => new Set(prev).add(epicId));
    fetchAllDonePastItems(epicId).then((items) => {
      setPastItemsByEpic((prev) => new Map(prev).set(epicId, items));
    }).finally(() => {
      setLoadingPastBundleEpicIds((prev) => {
        const next = new Set(prev);
        next.delete(epicId);
        return next;
      });
    });
  }, [pastItemsByEpic]);

  // story #2353 포트 잇기 — flow-epic-nodes.tsx의 단일-레인 판과 같은 낙관적-업데이트-금지
  // 원칙(AC14: 서버 200/201 뒤에만 edges를 갱신)이되, 레인이 여럿이라 «어느 레인의 edges에
  // 얹을지»를 먼저 찾아야 한다 — apiSourceId(포트를 끈 쪽)가 now/upcoming 어디에 있는지로
  // 판정한다(오늘은 레인 간 연결을 안 다룬다 — 그건 goal-edges, #25, BE 대기).
  const findEpicIdForStoryId = useCallback((storyId: string): string | null => {
    if (state.kind !== 'ready') return null;
    for (const [epicId, ing] of state.ingredientsByEpic) {
      if (ing.data.now.items.some((i) => i.id === storyId)) return epicId;
      if (ing.data.upcoming.items.some((i) => i.id === storyId)) return epicId;
    }
    return null;
  }, [state]);

  const handleCreateLink = useCallback(async (params: { apiSourceId: string; targetId: string; relationKind: string | null }): Promise<CreateLinkResult> => {
    try {
      const res = await fetch(`/api/stories/${params.apiSourceId}/reference-candidates`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ target_id: params.targetId, relation_kind: params.relationKind }),
      });
      const json = await res.json().catch(() => null);
      // story #2485 — `json.detail`은 실 envelope에 없는 필드라 이 분기는 항상
      // 죽어있었다(그라운딩 확認). backend create_story_reference_candidate()는
      // generic HTTP상태 코드만 낸다 — 고정 폴백만 사용.
      if (!res.ok) {
        return { ok: false, error: t('portLinkErrorFallback') };
      }
      const epicId = findEpicIdForStoryId(params.apiSourceId) ?? findEpicIdForStoryId(params.targetId);
      if (epicId) {
        const edge = declareResponseToEdge(params.apiSourceId, {
          target_id: json.target_id, relation_kind: json.relation_kind, status: json.status,
        });
        setState((prev) => {
          if (prev.kind !== 'ready') return prev;
          const ing = prev.ingredientsByEpic.get(epicId);
          if (!ing) return prev;
          const nextIngredients = new Map(prev.ingredientsByEpic);
          nextIngredients.set(epicId, {
            ...ing,
            edges: [...ing.edges, { ...edge, candidateId: json.id, declaredBy: json.declared_by, declaredAt: json.declared_at }],
          });
          return { ...prev, ingredientsByEpic: nextIngredients };
        });
      }
      return { ok: true };
    } catch {
      return { ok: false, error: t('portLinkErrorFallback') };
    }
  }, [t, findEpicIdForStoryId]);

  const handleDeleteLink = useCallback(async (candidateId: string, anchorStoryId: string): Promise<DeleteLinkResult> => {
    try {
      const res = await fetch(`/api/stories/${anchorStoryId}/reference-candidates/${candidateId}`, { method: 'DELETE' });
      if (!res.ok) {
        // story #2485 — `json.detail`은 실 envelope에 없는 필드라 이 분기는 항상
        // 죽어있었다(그라운딩 확認). backend undeclare_story_reference_candidate()는
        // generic HTTP상태 코드만 낸다 — 고정 폴백만 사용.
        return { ok: false, error: t('portLinkErrorFallback') };
      }
      setState((prev) => {
        if (prev.kind !== 'ready') return prev;
        const nextIngredients = new Map(prev.ingredientsByEpic);
        for (const [epicId, ing] of nextIngredients) {
          if (ing.edges.some((e) => e.candidateId === candidateId)) {
            nextIngredients.set(epicId, { ...ing, edges: ing.edges.filter((e) => e.candidateId !== candidateId) });
            break;
          }
        }
        return { ...prev, ingredientsByEpic: nextIngredients };
      });
      return { ok: true };
    } catch {
      return { ok: false, error: t('portLinkErrorFallback') };
    }
  }, [t]);

  // story #2357 — handleDeleteLink와 같은 형태·같은 ingredientsByEpic 갱신 패턴, 다른
  // 엔드포인트(reject).
  const handleRejectLink = useCallback(async (candidateId: string, anchorStoryId: string): Promise<RejectLinkResult> => {
    try {
      const res = await fetch(`/api/stories/${anchorStoryId}/reference-candidates/${candidateId}/reject`, { method: 'POST' });
      if (!res.ok) {
        // story #2485 — `json.detail`은 실 envelope에 없는 필드라 이 분기는 항상
        // 죽어있었다(그라운딩 확認). backend reject_story_reference_candidate()는
        // generic HTTP상태 코드만 낸다 — 고정 폴백만 사용.
        return { ok: false, error: t('portRejectErrorFallback') };
      }
      setState((prev) => {
        if (prev.kind !== 'ready') return prev;
        const nextIngredients = new Map(prev.ingredientsByEpic);
        for (const [epicId, ing] of nextIngredients) {
          if (ing.edges.some((e) => e.candidateId === candidateId)) {
            nextIngredients.set(epicId, { ...ing, edges: ing.edges.filter((e) => e.candidateId !== candidateId) });
            break;
          }
        }
        return { ...prev, ingredientsByEpic: nextIngredients };
      });
      return { ok: true };
    } catch {
      return { ok: false, error: t('portRejectErrorFallback') };
    }
  }, [t]);

  // 재료(fetch 결과)는 캐시하고, pastItems가 바뀔 때마다 deriveFlowMapLane(순수함수, 값싸다)을
  // «다시» 태운다 — 이미 파생된 lane 위에 pastNodes만 덮으면 과거-펼침 좌표·간선이 안 맞는다.
  const lanes = useMemo(() => {
    if (state.kind !== 'ready') return [];
    return expandGoals.flatMap((g) => {
      const ing = state.ingredientsByEpic.get(g.id);
      if (!ing) return [];
      const pastItems = pastItemsByEpic.get(g.id) ?? [];
      return [deriveFlowMapLane(
        g.id, ing.epicTitle, ing.data.past.total, ing.data.now.items, ing.data.upcoming.items, ing.edges, pastItems,
      )];
    });
  }, [state, expandGoals, pastItemsByEpic]);

  if (state.kind === 'loading') {
    return (
      <div className="flex items-center gap-2 py-6 text-xs text-muted-foreground">
        <Loader2 className="size-4 animate-spin" aria-hidden="true" />
        {t('nodesLoading')}
      </div>
    );
  }
  if (state.kind === 'error') {
    return <p className="px-2 py-2 text-[11px] text-muted-foreground">{t('nodesError')}</p>;
  }

  return (
    <div className="space-y-0">
      {/* story #2224 AC18 — pane 높이를 사용자가 지정한다(레인 단위 스냅, 하한 1레인,
          기본=레인 3까지 누적, localStorage 영속, 되돌리기). FlowMapCanvas 자체는 높이를
          모른다 — 이 래퍼가 «몇 레인이 보이는가»만 결정하고 클리핑한다. */}
      <FlowCanvasResizePane
        lanes={lanes}
        nodeRowHeight={NODE_ROW_HEIGHT}
        laneMinHeight={LANE_MIN_HEIGHT}
        headerHeight={HEADER_HEIGHT}
        // story #2369 QA 후속(2026-07-31, 유나 design:changes ③) — 배지 마크업은
        // FlowCanvasOffscreenHint(flow-map-canvas.tsx) 단일 소스에서만 나온다(예전엔 여기
        // 손으로 복제한 사본이었다). overlay로 넘기는 이유는 FlowCanvasResizePane이 이 자리를
        // 세로 클리핑 «밖»(스크롤 컨테이너의 형제)에 그리기 때문 — FlowMapCanvas 안에 있었으면
        // 콘텐츠 전체 높이 기준이 돼 클리핑 안(스크롤해야 보이는 자리)에 갔다.
        overlay={<FlowCanvasOffscreenHint count={offscreenCardCount} />}
      >
        <FlowMapCanvas
          lanes={lanes}
          onSelectStory={onSelectStory}
          onTogglePastBundle={handleTogglePastBundle}
          loadingPastBundleEpicIds={loadingPastBundleEpicIds}
          selectedNodeId={selectedNodeId}
          onCreateLink={handleCreateLink}
          onDeleteLink={handleDeleteLink}
          onRejectLink={handleRejectLink}
          memberMap={memberMap}
          onOffscreenCountChange={setOffscreenCardCount}
          focusGoalId={focusGoalId}
        />
      </FlowCanvasResizePane>
      {/* 접힘 줄(목업 그대로) — "숨긴 것이 아니라 접은 것입니다". 오늘은 펼치기 인터랙션이
          없다(30일 재계산은 새로고침으로 자연히 갱신된다) — 화면이 «왜» 접었는지만 정직하게
          말한다. */}
      {foldedCount > 0 ? (
        <div className="flex items-center gap-2 border-t border-border bg-muted/40 px-3 py-2 text-[11px] text-muted-foreground">
          <span aria-hidden="true">▸</span>
          <b className="text-foreground">{t('flowLaneFoldedCount', { n: foldedCount })}</b>
          <span>{t('flowLaneFoldedReason')}</span>
        </div>
      ) : null}
    </div>
  );
}
