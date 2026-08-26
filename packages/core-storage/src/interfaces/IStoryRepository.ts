import type { PaginationOptions } from '../types';
import type { RepositoryScopeContext } from './IEpicRepository';
import type { MetricDefinition, OutcomeResult } from './outcome';

export interface Story {
  id: string;
  org_id: string;
  project_id: string;
  epic_id: string | null;
  sprint_id: string | null;
  assignee_id: string | null;
  // story 9ac9b80f(BE #2222): 프로젝트 내 사람-읽는 순차 #N. 서버 채번(allocate_story_number)
  // 전용, client-settable 아님. 구 스토리는 백필 전이면 null일 수 있음(정직 미표시).
  story_number: number | null;
  title: string;
  status: string;
  priority: string;
  story_points: number | null;
  description: string | null;
  acceptance_criteria: string | null;
  position: number | null;
  success_hypothesis: string | null;
  metric_definition: MetricDefinition | null;
  measure_after: string | null;
  outcome_status: 'n_a' | 'pending' | 'hit' | 'miss' | null;
  outcome_result: OutcomeResult | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  // E-VERIFY V0-S1/S2: 실증-done 신뢰 신호. positive 단방향(false 절대 안 씀) — true면 근거 有,
  // null이면 완전 무표시(신뢰 표면 렌더 조건 그 자체).
  has_evidence?: boolean | null;
  // story #2328(C-11 ㉡층, PR#2659): boost_candidates_from 필터를 줬을 때만 non-default —
  // 그 스토리 본문에서 발견된 의미 후보(status="estimated")면 true + 매칭 스니펫.
  is_reference_candidate?: boolean;
  matched_snippet?: string | null;
}

export interface CreateStoryInput {
  project_id: string;
  org_id: string;
  title: string;
  epic_id?: string | null;
  sprint_id?: string | null;
  assignee_id?: string | null;
  status?: string;
  priority?: string;
  story_points?: number | null;
  description?: string | null;
  acceptance_criteria?: string | null;
  meeting_id?: string | null;
  success_hypothesis?: string | null;
  metric_definition?: MetricDefinition | null;
  measure_after?: string | null;
}

export interface UpdateStoryInput {
  title?: string;
  status?: string;
  priority?: string;
  story_points?: number | null;
  description?: string | null;
  acceptance_criteria?: string | null;
  attachments?: { url: string; name: string; content_type: string; size: number }[] | null;
  epic_id?: string | null;
  sprint_id?: string | null;
  assignee_id?: string | null;
  assignee_ids?: string[] | null;
  position?: number | null;
  success_hypothesis?: string | null;
  metric_definition?: MetricDefinition | null;
  measure_after?: string | null;
  // story #2868/#2874 자매(2026-08-21) — BE 낙관적 동시성(409 STORY_CONFLICT) 제어 필드.
  // updateStorySchema(zod)에 이어 이 타입에도 없으면 ALLOWED_FIELDS(story.ts)/fastapiCall
  // 본문 어디선가 다시 조용히 새거나 컴파일 자체가 막힌다 — 전 구간 SSOT로 여기서 열어 둔다.
  expected_updated_at?: string;
  force_overwrite?: boolean;
}

export interface BulkUpdateItem {
  id: string;
  status?: string;
  sprint_id?: string | null;
  assignee_id?: string | null;
}

export interface StoryComment {
  id: string;
  story_id: string;
  content: string;
  created_by: string;
  created_at: string;
}

export interface StoryListFilters extends PaginationOptions {
  sprint_id?: string;
  epic_id?: string;
  assignee_id?: string;
  status?: string;
  project_id?: string;
  q?: string;
  unassigned?: boolean;
  /** story #2534(E-FLOW-V4 S4) — 가설/목표 둘 다 미매달림(BE #2532 stories.py:137
   * `unattached` 쿼리와 동형). `unassigned`(담당자 미배정)와 다른 축이라 별도 필드. */
  unattached?: boolean;
  /** story #2283 — 사람-읽는 #N(project 내에서만 유일)으로 정확 lookup(제목 ILIKE 아님). */
  story_number?: number;
  /** story ca37b2b0 — 고정 id 집합 배치 조회(BE 200개 cap). 주어지면 커서 페이지네이션과
   * 무관한 배치 lookup 의미론(정확히 이 id들만, project 필터와 무관하게 cross-project는
   * BE가 조용히 걸러냄). */
  ids?: string[];
  /** story #2328(C-11 ㉡층) — 이 story_id의 의미 후보를 결과 맨 앞으로 재정렬(필터 아님,
   * q 비어도 동작). 해당 항목엔 is_reference_candidate=true·matched_snippet이 실린다. */
  boost_candidates_from?: string;
  /** story #3019(실사고 처방) — epic_id IN(...) 필터. `epic_id`(단일)와 별개 — 여러 에픽을
   * 한 번에(스윔레인 뷰의 "활성 에픽 전체") 좁힌다. `epic_unassigned`와 함께 쓰면 OR 결합. */
  epic_ids?: string[];
  /** story #3019 — epic_id IS NULL인 story도 포함(가설 링크 유무 무관). `unattached`(#2532,
   * 가설까지 검사)나 `unassigned`(담당자 미배정, 완전 별개 축)와 다른 개념 — 이름 충돌
   * 방지로 "unassigned" 단독이 아닌 "epic_unassigned"로 명명. */
  epic_unassigned?: boolean;
  /** story #3019 — status=done row만 created_at이 최근 N일 이내인 것으로 제한(list_board의
   * done-7일 관례를 제네릭 경로에 일반화). done 아닌 상태는 나이 무관 전부 포함. */
  done_within_days?: number;
}

export interface IStoryRepository {
  create(input: CreateStoryInput): Promise<Story>;
  list(filters: StoryListFilters): Promise<Story[]>;
  backlog(projectId: string): Promise<Story[]>;
  getById(id: string, scope?: RepositoryScopeContext): Promise<Story>;
  getByIdWithDetails(id: string, scope?: RepositoryScopeContext): Promise<Story & { tasks: unknown[] }>;
  update(id: string, input: UpdateStoryInput): Promise<Story>;
  delete(id: string): Promise<void>;
  bulkUpdate(items: BulkUpdateItem[]): Promise<Story[]>;
  addComment(input: { story_id: string; content: string; created_by: string }): Promise<StoryComment>;
  getComments(storyId: string, options?: PaginationOptions): Promise<StoryComment[]>;
  getActivities(storyId: string, options?: PaginationOptions): Promise<unknown[]>;
  addActivity(input: { story_id: string; org_id: string; actor_id: string; action_type: string; old_value?: string | null; new_value?: string | null }): Promise<void>;
}
