/**
 * story #3844(UX-v3·FE 4·일감 1) — 「일감」 목록 탭: 목표→스토리→일 3단 파생(순수 함수,
 * fetch 0). 정본 시안 3840 v2(artifact 06d2d61c)·doc a699be00 §②-1·§①.
 *
 * 그라운딩(2026-09-14, 코드 실측·PO 확定 다수):
 * - 「진행 중 · N/M 완료」는 «일»(task+agent_run) 단위(PO 確定) — goal.total_stories/
 *   done_stories(스토리 단위, BE 이미 집계)는 다른 단위라 안 쓴다(같은 헤더에 두 단위 섞으면
 *   두 세계).
 * - 위험 칩은 risk_grade='low'일 때만 「저위험」 1개(PO 確定) — risk_grade='high'는 칩 0
 *   (상태 pill 「서명 대기」가 이미 그 사실을 말하므로 같은 사실 두 낱말 금지). 「외부 발송」·
 *   「돈」 칩은 GateResponse에 risk_kind 축 자체가 없어(risk_grade만 low/high 2값) 이번
 *   카드에서 못 그린다 — BE 갭(별 카드는 PO).
 * - 행 상태(§① 4어)는 **GET /api/gates/inbox**(BE list_gate_inbox, story #2054 — Gate∪
 *   HitlRequest(gate_approval park) 통합 read-layer, 새 API 0 그대로 재사용) 안의 그
 *   work_item에 걸린 pending 항목이 이긴다 — PO 매핑 확定(3831 판정과 동형,
 *   today_service.py::_needs_me_from_gate_inbox의 `is_signature = gate_type ==
 *   'external_publish'` 그대로): source='gate'면 (gate_type='external_publish' 이거나
 *   risk_grade='high')일 때 서명 대기·그 외(approval류+low/null risk) 승인 대기,
 *   source='hitl'이면 답 대기(HitlInboxItem.work_item_id는 BE 주석 근거 "실무상 항상
 *   Story"). 없으면 task.status(todo/in_progress/done)에서 진행 중/완료로 폴백. agent_run
 *   행은 agent_run.status에서 직접(오늘 화면 _AGENT_RUN_IN_PROGRESS_STATUSES와 동형).
 *   애초에 별도 hitl-requests 소스(/api/v1/hitl-requests → list_hitl_requests)를 쓰려
 *   했으나 그 응답(HitlRequestResponse)엔 work_item_id 자체가 없어(실측, backend/app/
 *   schemas/hitl.py) work-item join이 원천 불가 — gates/inbox(HitlInboxItem)가 유일한
 *   join 가능 경로.
 * - agent_run 행 제목은 today_service.py::_resolve_agent_progress와 동형 선례(work_item_title
 *   = 그 run이 달린 story의 title) — AgentRunResponse 자체엔 title 필드가 없다(지어내지 않음).
 * - 배정/위임은 Task.assignee_id → team_members[].type('human'|'agent') 교차대조(Task 응답
 *   자체엔 타입 필드가 없다).
 * - 문서(docs) 칩은 이번 카드에서 뺐다(BE 갭 — /api/docs에 story_id 필터 0·story 응답에 문서
 *   연결 카운트 필드 0, PO 確定). 산출물(artifact) 칩은 story_id별 실 개수("산출물 N", PO
 *   지적 2026-09-14 — 있음/없음이 아니라 개수) — /api/visual-artifacts(project 전체, story_id
 *   미지정)를 한 번 받아 story_id로 집계, N+1 없음.
 * - 담당 이름(ownerName)은 위임 행뿐 아니라 사람 배정 행도 team_members 이름으로 채운다(PO
 *   지적 2026-09-14 — 처음엔 위임 행에만 채우고 사람 배정 행은 null로 뒀다).
 * - 목표 헤더 「진행 중」 낱말은 GoalStatus==='active'일 때만(PO 지적 — 시안 06d2d61c
 *   재대조, 데이터 없으면 지어내지 않는다). 기간 pill(예: 「이번 주」)은 target_date 기반
 *   설계가 이 카드 스코프 밖이라 생략(PO 승인 — 데이터 없으면 생략이 원칙).
 * - 「가설: <가설>」 필터: HypothesisResponse.epic_ids/story_ids(N:M) 실측 근거로, 스토리가
 *   그 가설의 story_ids에 직접 있거나 그 스토리의 부모 goal이 epic_ids에 있으면 매치(가설이
 *   goal에 걸려 있으면 그 아래 모든 스토리가 관련 — 직접 연결과 상속 연결을 다 인정하는
 *   쪽으로 판단, PO 사후보고 예정). hasMore 없는 소스(agent-runs/inbox와 동형, /api/
 *   hypotheses는 project_id만으로 project 전체를 페이지네이션 없이 준다).
 */

import { deriveGateState } from './work-list-detail-actions';

export type WorkListRowKind = 'task' | 'agent_run';
export type WorkListRowState = 'awaiting_approval' | 'awaiting_signature' | 'awaiting_answer' | 'in_progress' | 'done' | null;

// 정본 소스: backend/sprintable_mcp/schemas.py::TaskStatus(Enum) — DB tasks_status_check와
// 동형(라이브 실측 2026-09-14). scripts/verify-task-status-be-parity.test.ts가 이 배열과 BE
// enum을 소스 대조해 전수 grep 0 불일치를 강제한다(카디르 계약값) — 손으로 친 리터럴이
// 다시 표류할 수 없게, 이 상수들을 거치지 않은 비교는 만들지 않는다.
export const TASK_STATUS_TODO = 'todo';
export const TASK_STATUS_IN_PROGRESS = 'in-progress';
export const TASK_STATUS_DONE = 'done';
export const TASK_STATUS_VALUES = [TASK_STATUS_TODO, TASK_STATUS_IN_PROGRESS, TASK_STATUS_DONE] as const;

// 정본 소스: backend/sprintable_mcp/schemas.py::GoalStatus(Enum) — draft|active|done|archived.
export const GOAL_STATUS_ACTIVE = 'active';

// today_service.py::_AGENT_RUN_IN_PROGRESS_STATUSES와 동일 SSOT(agent_runs.py
// _AGENT_RUN_STATUS_VALUES: queued|held|running|hitl_pending|completed|failed|abandoned 중
// completed만 종결로 세고, failed/abandoned는 §①에 대응 낱말이 없어 null로 둔다 — 지어내지 않음).
const AGENT_RUN_IN_PROGRESS_STATUSES = new Set(['queued', 'held', 'running', 'hitl_pending']);

// ── 입력(각 route 실 응답 형 그대로 — 자체 가공 0) ──────────────────────────────

export interface WorkListGoalInput {
  id: string;
  title: string;
  /** 정본 소스: backend/sprintable_mcp/schemas.py::GoalStatus(Enum) — draft|active|done|
   * archived. 「진행 중」 낱말은 status==='active'일 때만(PO 지적 2026-09-14, 시안 06d2d61c
   * 재대조 — 데이터 없으면 지어내지 않는다). */
  status: string;
}

export interface WorkListStoryInput {
  id: string;
  title: string;
  /** BE StoryResponse.epic_id — 목표 id. */
  epic_id: string | null;
}

export interface WorkListTaskInput {
  id: string;
  story_id: string;
  assignee_id: string | null;
  title: string;
  /** BE tasks 테이블 CHECK 제약(실측, 로컬 DB `tasks_status_check`) — 'todo'|'in-progress'|
   * 'done' 3값만 허용(하이픈, 언더스코어 아님 — 처음엔 in_progress로 잘못 가정했다가 실
   * INSERT 22P02 위반으로 발견). 그 외 값은 진행 중으로도 완료로도 안 보고 상태 낱말을
   * 생략한다(지어내지 않음). */
  status: string;
}

export interface WorkListAgentRunInput {
  id: string;
  story_id: string | null;
  agent_id: string;
  agent_name: string | null;
  status: string;
}

/** GET /api/gates/inbox 원소 — BE response_model=list[GateResponse|HitlInboxItem]
 * (discriminator="source")의 이 함수가 쓰는 부분집합만. */
export type WorkListInboxItem =
  | { source: 'gate'; id: string; work_item_id: string; work_item_type: string; status: string; gate_type: string; risk_grade: 'low' | 'high' | null }
  | { source: 'hitl'; id: string; work_item_id: string | null; status: string; title: string; prompt: string };

export interface WorkListTeamMemberInput {
  id: string;
  type: string;
  name: string | null;
}

/** GET /api/hypotheses?project_id= 원소 부분집합. */
export interface WorkListHypothesisInput {
  id: string;
  statement: string;
  epic_ids: string[];
  story_ids: string[];
}

export interface WorkListRow {
  id: string;
  kind: WorkListRowKind;
  workItemType: 'task' | 'story';
  workItemId: string;
  title: string;
  /** 담당자 표시명(있을 때만·PO 지적 2026-09-14 — 위임 행뿐 아니라 사람 배정 행도 이름을
   * 보인다). team_members 조회로 못 채우면(이름 없는 멤버 등) null — 지어내지 않는다. */
  ownerName: string | null;
  isDelegated: boolean;
  lowRisk: boolean;
  /** 이 행의 부모 스토리에 연결된 산출물 개수(0=칩 안 그림). PO 지적 — 있음/없음이 아니라
   * 실 개수("산출물 N")를 보인다. */
  artifactCount: number;
  state: WorkListRowState;
}

export interface WorkListStoryGroup {
  storyId: string;
  title: string;
  rows: WorkListRow[];
  /** 이 스토리에 직접·상속(부모 goal 경유) 둘 다로 연결된 가설 id들(필터용). */
  hypothesisIds: string[];
}

export interface WorkListGoalGroup {
  goalId: string;
  title: string;
  /** GoalStatus==='active'인지(「진행 중」 낱말용 — PO 지적, 데이터 없으면 지어내지 않는다). */
  isActive: boolean;
  doneCount: number;
  totalCount: number;
  assignedCount: number;
  delegatedCount: number;
  /** 시안 3840 v2(artifact 06d2d61c) 목표 헤더 "사람 배정 N · 에이전트 위임 M · 가설 K" —
   * 이 목표 아래 스토리들의 hypothesisIds 합집합 크기(story.hypothesisIds와 동일 직접+상속
   * 규칙, 중복 제거). */
  hypothesisCount: number;
  stories: WorkListStoryGroup[];
}

export interface WorkList {
  groups: WorkListGoalGroup[];
  /** goals/stories/tasks·agent_runs 커서 hasMore 중 하나라도 true거나 null(모름)이면
   * true(story #3844 AC1 — 「없다」 단정 금지, 안전 쪽으로 접는다). agent_runs는 story
   * #3857(FE 프록시 4곳 X-Total-Count/X-Next-Cursor 통과)부터 이 축에 합류 — 그 전엔
   * FE 프록시가 그 헤더를 못 읽어 fetch-work-list.ts의 별도 길이===limit 휴리스틱으로
   * 임시 처리했다(#3844 PO 確定, 이 스토리가 정식 축으로 흡수·휴리스틱은 삭제). gates/
   * inbox·team-members·hypotheses는 여전히 BE 계약상 페이지네이션 자체가 없는 소스라
   * partial 판정에 안 들어간다(team-members는 라이브 실측 2026-09-14 — list_team_members에
   * limit/cursor 파라미터가 아예 없다, 처음엔 규약 A 페이지 소스로 잘못 모델링해 실 데이터
   * 0건인데도 "전부 불러오지 못했어요" 배너가 항상 뜨는 결함을 라이브 검증에서 발견·수정). */
  partial: boolean;
}

export interface WorkListPageResult<T> {
  items: T[];
  /** true=더 있음 확실·false=이게 전부 확실·null=이 소스 자체가 "더 있는지 모른다"인
   * 소스용 — null은 partial 판정에서 true로 접는다(모르면 단정 안 함). */
  hasMore: boolean | null;
}

export interface WorkListInput {
  goals: WorkListPageResult<WorkListGoalInput>;
  stories: WorkListPageResult<WorkListStoryInput>;
  tasks: WorkListPageResult<WorkListTaskInput>;
  agentRuns: WorkListPageResult<WorkListAgentRunInput>;
  /** GET /api/gates/inbox?status=pending 전체(페이지네이션 없는 org 스코프 소스). */
  inbox: WorkListInboxItem[];
  /** GET /api/team-members 전체(페이지네이션 없는 소스, list_team_members에 limit/cursor
   * 파라미터 자체가 없음 — 라이브 실측). */
  teamMembers: WorkListTeamMemberInput[];
  /** /api/visual-artifacts(project 전체) story_id별 개수 — 0이면 칩 안 그림, 있으면 실 개수
   * 표시("산출물 N", PO 지적 2026-09-14). */
  artifactCountByStoryId: ReadonlyMap<string, number>;
  /** GET /api/hypotheses?project_id= 전체(페이지네이션 없는 project 스코프 소스). */
  hypotheses: WorkListHypothesisInput[];
}

function isPartial(...results: Array<WorkListPageResult<unknown>>): boolean {
  return results.some((r) => r.hasMore !== false);
}

/** work_item_id로 pending inbox 항목 1건을 찾는다(같은 자리에 여럿이면 먼저 찾힌 것 —
 * 오늘 화면의 dedupe만큼 정교하지 않음, 스코프 밖 명시). hitl 항목의 work_item_type은
 * BE 주석 근거로 항상 'story'라 별도 필드 없이 story 조회에서만 함께 본다. */
function findPendingInbox(inbox: WorkListInboxItem[], workItemType: 'task' | 'story', workItemId: string): WorkListInboxItem | null {
  return inbox.find((it) => {
    if (it.status !== 'pending') return false;
    if (it.source === 'gate') return it.work_item_type === workItemType && it.work_item_id === workItemId;
    return workItemType === 'story' && it.work_item_id === workItemId;
  }) ?? null;
}

function stateFromInboxItem(item: WorkListInboxItem): WorkListRowState {
  if (item.source === 'hitl') return 'awaiting_answer';
  // 카디르 계약값 ⑥(페드루 판정 2026-09-14 10:55Z) — 옛 OR-조건(gate_type===external_publish
  // ||risk_grade==='high')이 work-list-detail-panel.tsx의 primaryActionLabelKey와 독립적으로
  // "서명 필요?"를 판정하다 갈라졌던 자리. work-list-detail-actions.ts::deriveGateState 하나로
  // 합쳐 두 자리가 같은 함수를 부른다(risk_grade===null→'unknown'→고위험 취급 정책도 이제 일치).
  return deriveGateState(item);
}

function lowRiskFromInboxItem(item: WorkListInboxItem | null): boolean {
  return item?.source === 'gate' && item.risk_grade === 'low';
}

function deriveTaskState(task: WorkListTaskInput, inboxItem: WorkListInboxItem | null): WorkListRowState {
  if (inboxItem) return stateFromInboxItem(inboxItem);
  if (task.status === TASK_STATUS_DONE) return 'done';
  if (task.status === TASK_STATUS_IN_PROGRESS) return 'in_progress'; // BE 값은 하이픈, 파생 상태값은 기존 관례대로 언더스코어 유지
  return null;
}

function deriveAgentRunState(run: WorkListAgentRunInput): WorkListRowState {
  if (run.status === 'completed') return 'done';
  if (AGENT_RUN_IN_PROGRESS_STATUSES.has(run.status)) return 'in_progress';
  return null; // failed/abandoned — §①에 대응 낱말 0, 지어내지 않는다.
}

export function deriveWorkList(input: WorkListInput): WorkList {
  const storyById = new Map(input.stories.items.map((s) => [s.id, s]));
  const memberTypeById = new Map(input.teamMembers.map((m) => [m.id, m.type]));
  const memberNameById = new Map(input.teamMembers.map((m) => [m.id, m.name]));

  const storyGroups = new Map<string, WorkListStoryGroup>();
  const goalTotals = new Map<string, { done: number; total: number; assigned: number; delegated: number }>();

  function hypothesisIdsForStory(story: WorkListStoryInput): string[] {
    return input.hypotheses
      .filter((h) => h.story_ids.includes(story.id) || (story.epic_id !== null && h.epic_ids.includes(story.epic_id)))
      .map((h) => h.id);
  }

  function ensureStoryGroup(story: WorkListStoryInput): WorkListStoryGroup {
    let g = storyGroups.get(story.id);
    if (!g) { g = { storyId: story.id, title: story.title, rows: [], hypothesisIds: hypothesisIdsForStory(story) }; storyGroups.set(story.id, g); }
    return g;
  }

  function bumpGoalTotals(goalId: string | null, row: WorkListRow): void {
    if (!goalId) return;
    const t = goalTotals.get(goalId) ?? { done: 0, total: 0, assigned: 0, delegated: 0 };
    t.total += 1;
    if (row.state === 'done') t.done += 1;
    if (row.isDelegated) t.delegated += 1; else t.assigned += 1;
    goalTotals.set(goalId, t);
  }

  for (const task of input.tasks.items) {
    const story = storyById.get(task.story_id);
    if (!story) continue; // 부모 스토리를 못 찾으면(다른 project 페이지 등) 짓지 않고 생략.
    const group = ensureStoryGroup(story);
    const inboxItem = findPendingInbox(input.inbox, 'task', task.id) ?? findPendingInbox(input.inbox, 'story', story.id);
    const memberType = task.assignee_id ? memberTypeById.get(task.assignee_id) : null;
    const isDelegated = memberType === 'agent';
    const row: WorkListRow = {
      id: task.id,
      kind: 'task',
      workItemType: 'task',
      workItemId: task.id,
      title: task.title,
      ownerName: task.assignee_id ? (memberNameById.get(task.assignee_id) ?? null) : null,
      isDelegated,
      lowRisk: lowRiskFromInboxItem(inboxItem),
      artifactCount: input.artifactCountByStoryId.get(story.id) ?? 0,
      state: deriveTaskState(task, inboxItem),
    };
    group.rows.push(row);
    bumpGoalTotals(story.epic_id, row);
  }

  for (const run of input.agentRuns.items) {
    if (!run.story_id) continue;
    const story = storyById.get(run.story_id);
    if (!story) continue;
    const group = ensureStoryGroup(story);
    const inboxItem = findPendingInbox(input.inbox, 'story', story.id);
    const row: WorkListRow = {
      id: run.id,
      kind: 'agent_run',
      workItemType: 'story',
      workItemId: story.id,
      // today_service.py::_resolve_agent_progress 선례 — agent_run 자체엔 title이 없어
      // 그 run이 달린 story의 title을 그대로 쓴다(지어내지 않음).
      title: story.title,
      ownerName: run.agent_name,
      isDelegated: true,
      lowRisk: lowRiskFromInboxItem(inboxItem),
      artifactCount: input.artifactCountByStoryId.get(story.id) ?? 0,
      state: inboxItem ? stateFromInboxItem(inboxItem) : deriveAgentRunState(run),
    };
    group.rows.push(row);
    bumpGoalTotals(story.epic_id, row);
  }

  const groups: WorkListGoalGroup[] = [];
  for (const goal of input.goals.items) {
    const stories: WorkListStoryGroup[] = [];
    for (const story of input.stories.items) {
      if (story.epic_id !== goal.id) continue;
      const g = storyGroups.get(story.id);
      if (g && g.rows.length > 0) stories.push(g);
    }
    if (stories.length === 0) continue; // 일이 하나도 없는 목표는 이 화면에서 안 그린다(빈 목표는 목표 화면 몫).
    const totals = goalTotals.get(goal.id) ?? { done: 0, total: 0, assigned: 0, delegated: 0 };
    const hypothesisIds = new Set<string>();
    for (const s of stories) for (const id of s.hypothesisIds) hypothesisIds.add(id);
    groups.push({
      goalId: goal.id,
      title: goal.title,
      isActive: goal.status === GOAL_STATUS_ACTIVE,
      doneCount: totals.done,
      totalCount: totals.total,
      assignedCount: totals.assigned,
      delegatedCount: totals.delegated,
      hypothesisCount: hypothesisIds.size,
      stories,
    });
  }

  return {
    groups,
    partial: isPartial(input.goals, input.stories, input.tasks, input.agentRuns),
  };
}
