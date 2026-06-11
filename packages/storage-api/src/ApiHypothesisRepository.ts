import type {
  IHypothesisRepository,
  Hypothesis,
  CreateHypothesisInput,
  UpdateHypothesisInput,
  HypothesisListFilters,
  HypothesisTransitionInput,
  HypothesisLinkInput,
  HypothesisUnlinkInput,
  HypothesisDraftInput,
  HypothesisDraft,
  RepositoryScopeContext,
} from '@sprintable/core-storage';
import { fastapiCall } from './utils';

/**
 * Hypothesis repository — FastAPI BE(/api/v2/hypotheses)에 `fastapiCall`로 직타한다.
 *
 * ⚠️ Api* 명명(Supabase* 아님): Supabase 클라이언트 미사용. 기존 레포지토리의 "Supabase*"
 * 명명은 미스리딩 레거시(내용물은 이미 fastapiCall)이며 신규는 Api* 명명만 쓴다.
 *
 * envelope 경계(E1-S7 AC③ · fc4d4264 교훈): BE는 성공 시 **raw model/list**를 반환한다
 * (블루프린트 §3.1/§3.5). `fastapiCall`은 그 raw 바디(`res.json()`)를 그대로 돌려주므로
 * **이 레이어에는 `{data}` envelope가 없다** — Next proxy가 라우트에서 다시 감쌀 때만
 * `{data}`가 생기며 그건 이 레이어 밖이다. 소비부는 항상 raw로 다룬다.
 */
export class ApiHypothesisRepository implements IHypothesisRepository {
  constructor(private readonly accessToken: string = '') {}

  async list(filters: HypothesisListFilters): Promise<Hypothesis[]> {
    return fastapiCall<Hypothesis[]>('GET', '/api/v2/hypotheses', this.accessToken, {
      query: {
        project_id: filters.project_id,
        epic_id: filters.epic_id,
        story_id: filters.story_id,
        status: filters.status,
        owner_member_id: filters.owner_member_id,
        limit: filters.limit,
        cursor: filters.cursor,
      },
    });
  }

  async create(input: CreateHypothesisInput): Promise<Hypothesis> {
    return fastapiCall<Hypothesis>('POST', '/api/v2/hypotheses', this.accessToken, { body: input });
  }

  async getById(id: string, _scope?: RepositoryScopeContext): Promise<Hypothesis> {
    return fastapiCall<Hypothesis>('GET', `/api/v2/hypotheses/${id}`, this.accessToken);
  }

  async update(id: string, input: UpdateHypothesisInput): Promise<Hypothesis> {
    return fastapiCall<Hypothesis>('PATCH', `/api/v2/hypotheses/${id}`, this.accessToken, { body: input });
  }

  async transition(id: string, input: HypothesisTransitionInput): Promise<Hypothesis> {
    return fastapiCall<Hypothesis>('POST', `/api/v2/hypotheses/${id}/transition`, this.accessToken, { body: input });
  }

  async link(id: string, input: HypothesisLinkInput): Promise<Hypothesis> {
    return fastapiCall<Hypothesis>('POST', `/api/v2/hypotheses/${id}/links`, this.accessToken, { body: input });
  }

  async unlink(id: string, input: HypothesisUnlinkInput): Promise<Hypothesis> {
    return fastapiCall<Hypothesis>('DELETE', `/api/v2/hypotheses/${id}/links`, this.accessToken, { body: input });
  }

  async archive(id: string): Promise<void> {
    await fastapiCall<void>('DELETE', `/api/v2/hypotheses/${id}`, this.accessToken);
  }

  async draft(input: HypothesisDraftInput): Promise<HypothesisDraft> {
    return fastapiCall<HypothesisDraft>('POST', '/api/v2/hypotheses/draft', this.accessToken, { body: input });
  }
}
