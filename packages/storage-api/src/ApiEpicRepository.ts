import type { IEpicRepository, Epic, CreateEpicInput, UpdateEpicInput, EpicListFilters, EpicPositionItem, RepositoryScopeContext } from '@sprintable/core-storage';
import { fastapiCall } from './utils';

export class ApiEpicRepository implements IEpicRepository {
  constructor(private readonly accessToken: string = '') {}

  async create(input: CreateEpicInput): Promise<Epic> {
    return fastapiCall<Epic>('POST', '/api/v2/goals', this.accessToken, { body: input, orgId: input.org_id });
  }

  async list(filters: EpicListFilters): Promise<Epic[]> {
    // 569f5316: limit/cursor/order_by를 BE에 위임해 1000+ silent-truncation을 근절.
    // (이전엔 project_id만 전달 → BE 1000 cap에서 조용히 잘림.) over-fetch(+1)는 라우트가 책임.
    // story 8fc51517 AC5: BE B1(#2225) 라이브 확認 후 신 엔드포인트로 전환(/api/v2/epics는
    // deprecated 별칭으로 계속 서빙되나, 신규 소비는 /goals가 SSOT). 응답 필드명은 id 그대로
    // (goal_id 아님 — backend/app/schemas/goal.py GoalResponse 실측 확認, FE 타입 무변경).
    // 결함 fix(2026-07-30) — `include`가 이 4번째 쿼리 인자로 빠져 있어 story #2298/#2303의
    // `include=glance` 옵트인이 BE(`goal.py` `Query(...include...)`)까지 한 번도 도달하지
    // 못했다. focal_story/participant_ids는 이 fix 이전엔 응답에 «키 자체가» 없었다(null도
    // 아님) — #2224 초점 스트립이 항상 빈 이유의 진짜 근본.
    return fastapiCall<Epic[]>('GET', '/api/v2/goals', this.accessToken, {
      query: {
        project_id: filters.project_id,
        cursor: filters.cursor,
        limit: filters.limit,
        order_by: filters.order_by,
        include: filters.include,
        // story #2262 PR②(BE #2905) — story ids(ca37b2b0)와 동일 계약, comma-separated.
        ids: filters.ids?.join(','),
      },
    });
  }

  async bulkUpdatePositions(items: EpicPositionItem[]): Promise<Epic[]> {
    // 로드맵 조타 재정렬(wedge #2·BE §1.4). org_id/project 인가는 BE 단일 소스(SEC-S8 W/W2)라
    // FE는 thin proxy — items만 포워드(백필0·갱신본만 반환). /{id}보다 먼저 매칭되도록 BE가 /bulk 선언.
    return fastapiCall<Epic[]>('PATCH', '/api/v2/goals/bulk', this.accessToken, { body: { items } });
  }

  async getById(id: string, _scope?: RepositoryScopeContext): Promise<Epic> {
    return fastapiCall<Epic>('GET', `/api/v2/goals/${id}`, this.accessToken);
  }

  async getByIdWithStories(id: string, scope?: RepositoryScopeContext): Promise<Epic & { stories: unknown[] }> {
    const epic = await this.getById(id, scope);
    const stories = await fastapiCall<unknown[]>('GET', '/api/v2/stories', this.accessToken, { query: { epic_id: id } });
    return { ...epic, stories };
  }

  async update(id: string, input: UpdateEpicInput): Promise<Epic> {
    return fastapiCall<Epic>('PATCH', `/api/v2/goals/${id}`, this.accessToken, { body: input });
  }

  async delete(id: string, _orgId: string): Promise<void> {
    await fastapiCall<void>('DELETE', `/api/v2/goals/${id}`, this.accessToken);
  }
}
