import { fetchWithAuth } from '@/lib/db/client';
import { parseCursorMeta } from '@/lib/pagination';
import {
  deriveWorkList,
  type WorkList,
  type WorkListAgentRunInput,
  type WorkListGoalInput,
  type WorkListHypothesisInput,
  type WorkListInboxItem,
  type WorkListPageResult,
  type WorkListStoryInput,
  type WorkListTaskInput,
  type WorkListTeamMemberInput,
} from './derive-work-list';

/**
 * story #3844 — 7개 기존 route를 병렬로 모아 deriveWorkList에 먹인다(새 API 0).
 *
 * - goals/stories/tasks/team-members: 규약 A(camelCase meta) — parseCursorMeta로 읽는다.
 * - agent-runs: 페이지네이션 없음(실측, 2026-09-14) — 응답 배열 그대로.
 * - gates/inbox: 페이지네이션 없음(BE 명시 계약, gates.py list_gate_inbox 문서화) —
 *   status=pending만 서버에 필터 요청(행 상태 판정엔 pending만 의미 있음).
 * - visual-artifacts: story_id 미지정 호출 시 BE가 호출자 project로 자동 스코프해 project
 *   전체 artifact를 limit=500까지 준다(list_artifacts, story #2428 PR④ 계약) — 그 안에서
 *   story_id를 뽑아 존재 Set만 만든다. ⚠️known gap: FE 프록시(api/visual-artifacts/route.ts)가
 *   BE의 has_more/next_cursor meta를 벗겨서 안 돌려준다(json.data만 재포장) — 그래서 이
 *   소스는 partial 판정에 못 들어간다(칩은 "있을 때만" 그리는 보조 신호라 500건 초과
 *   project에서 일부 story의 칩이 빠질 수 있음, best-effort로 수용 — 지어내지 않되 단정도
 *   안 함. 프록시 자체를 고치는 건 이 카드 스코프 밖).
 * - hypotheses: project_id만으로 project 전체(페이지네이션 없음, 실측 — service.list가
 *   raw 배열만 반환) — 가설 필터 드롭다운 재료 + 스토리별 hypothesisIds 매칭 재료.
 */

interface Envelope<T> {
  data: T;
  meta: unknown;
}

// org-briefing-shell.tsx::useTodayData 선례와 동형 — fetchWithAuth는 Response를 주지 json을
// 안 준다, 여기서 명시적으로 .json()까지 내린다.
async function fetchEnvelope<T>(url: string): Promise<Envelope<T>> {
  const res = await fetchWithAuth(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  return (await res.json()) as Envelope<T>;
}

async function fetchPage<T>(url: string, source: string): Promise<WorkListPageResult<T>> {
  const json = await fetchEnvelope<T[]>(url);
  const meta = parseCursorMeta(json.meta, source);
  return { items: Array.isArray(json.data) ? json.data : [], hasMore: meta.malformed ? null : meta.hasMore };
}

const PAGE_LIMIT = 100;

export async function fetchWorkList(projectId: string): Promise<WorkList> {
  const [goals, stories, tasks, agentRunsJson, inboxJson, teamMembers, artifactsJson, hypothesesJson] = await Promise.all([
    fetchPage<WorkListGoalInput>(`/api/goals?project_id=${projectId}&limit=${PAGE_LIMIT}`, '/api/goals'),
    fetchPage<WorkListStoryInput>(`/api/stories?project_id=${projectId}&limit=${PAGE_LIMIT}`, '/api/stories'),
    fetchPage<WorkListTaskInput>(`/api/tasks?project_id=${projectId}&limit=${PAGE_LIMIT}`, '/api/tasks'),
    fetchEnvelope<WorkListAgentRunInput[]>(`/api/agent-runs?project_id=${projectId}&limit=200`),
    fetchEnvelope<WorkListInboxItem[]>('/api/gates/inbox?status=pending'),
    fetchPage<WorkListTeamMemberInput>('/api/team-members', '/api/team-members'),
    fetchEnvelope<Array<{ story_id: string | null }>>('/api/visual-artifacts'),
    fetchEnvelope<WorkListHypothesisInput[]>(`/api/hypotheses?project_id=${projectId}`),
  ]);

  const storyIdsWithArtifacts = new Set(
    (Array.isArray(artifactsJson.data) ? artifactsJson.data : [])
      .map((a) => a.story_id)
      .filter((id): id is string => Boolean(id)),
  );

  return deriveWorkList({
    goals,
    stories,
    tasks,
    agentRuns: Array.isArray(agentRunsJson.data) ? agentRunsJson.data : [],
    inbox: Array.isArray(inboxJson.data) ? inboxJson.data : [],
    teamMembers,
    storyIdsWithArtifacts,
    hypotheses: Array.isArray(hypothesesJson.data) ? hypothesesJson.data : [],
  });
}
