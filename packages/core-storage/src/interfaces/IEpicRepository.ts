import type { PaginationOptions } from '../types';

export interface RepositoryScopeContext {
  org_id?: string;
  project_id?: string;
}

export interface Epic {
  id: string;
  org_id: string;
  project_id: string;
  title: string;
  status: string;
  priority: string;
  description: string | null;
  objective: string | null;
  success_criteria: string | null;
  target_sp: number | null;
  target_date: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  // E-GLANCE wedge #2(로드맵 조타·BE #2076): 큐레이션 순서. null=미조타(자동도출). source_loop_id는
  // 계보 인터페이스(Loop 제안 hook)뿐 — 실 배선은 P3/v2, v1은 타입만 통과(no-fiction).
  position?: number | null;
  source_loop_id?: string | null;
}

export interface CreateEpicInput {
  project_id: string;
  org_id: string;
  title: string;
  status?: string;
  priority?: string;
  description?: string | null;
  objective?: string | null;
  success_criteria?: string | null;
  target_sp?: number | null;
  target_date?: string | null;
}

export interface UpdateEpicInput {
  title?: string;
  status?: string;
  priority?: string;
  description?: string | null;
  objective?: string | null;
  success_criteria?: string | null;
  target_sp?: number | null;
  target_date?: string | null;
}

export interface EpicListFilters extends PaginationOptions {
  project_id?: string;
  /** 단조 정렬 컬럼(created_at/updated_at). BE에 위임해 true cursor 페이지네이션에 사용.
   * "position"(로드맵 조타·wedge #2)은 복합 정렬((position IS NULL) ASC, position ASC,
   * created_at DESC)이라 BE가 X-Next-Cursor를 내지 않는다 — 소비 측은 커서 이어달리기 금지. */
  order_by?: string;
}

/** 로드맵 조타 재정렬(wedge #2·BE `PATCH /api/v2/epics/bulk`). 큐레이션한 에픽만 position 세팅. */
export interface EpicPositionItem {
  id: string;
  position: number;
}

export interface IEpicRepository {
  create(input: CreateEpicInput): Promise<Epic>;
  list(filters: EpicListFilters): Promise<Epic[]>;
  /** 로드맵 조타 재정렬 — items의 에픽만 position 갱신(백필0). 갱신본만 반환. */
  bulkUpdatePositions(items: EpicPositionItem[]): Promise<Epic[]>;
  getById(id: string, scope?: RepositoryScopeContext): Promise<Epic>;
  getByIdWithStories(id: string, scope?: RepositoryScopeContext): Promise<Epic & { stories: unknown[] }>;
  update(id: string, input: UpdateEpicInput): Promise<Epic>;
  delete(id: string, orgId: string): Promise<void>;
}
