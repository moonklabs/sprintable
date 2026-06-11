import type {
  IHypothesisRepository,
  CreateHypothesisInput,
  UpdateHypothesisInput,
  HypothesisListFilters,
  HypothesisTransitionInput,
  HypothesisLinkInput,
  HypothesisUnlinkInput,
  HypothesisDraftInput,
} from '@sprintable/core-storage';
import { ApiHypothesisRepository } from '@sprintable/storage-api';
import { NotFoundError } from './sprint';

export type { CreateHypothesisInput, UpdateHypothesisInput };

export class HypothesisService {
  private readonly repo: IHypothesisRepository;

  constructor(repo: IHypothesisRepository) {
    this.repo = repo;
  }

  static fromToken(accessToken: string): HypothesisService {
    return new HypothesisService(new ApiHypothesisRepository(accessToken));
  }

  async list(filters: HypothesisListFilters) {
    if (!filters.project_id) throw new Error('project_id is required');
    return this.repo.list(filters);
  }

  async create(input: CreateHypothesisInput) {
    if (!input.project_id) throw new Error('project_id is required');
    if (!input.statement?.trim()) throw new Error('statement is required');
    return this.repo.create(input);
  }

  async getById(id: string) {
    try {
      return await this.repo.getById(id);
    } catch (err) {
      if (err instanceof Error && err.name === 'NotFoundError') throw new NotFoundError('Hypothesis not found');
      throw err;
    }
  }

  /**
   * AC①: ALLOWED_FIELDS는 shared `updateHypothesisSchema`·core `UpdateHypothesisInput`과
   * 1:1로 동기화한다. `status`/`outcome_result`는 transition endpoint 전용이라 절대 통과
   * 금지 — zod가 strip하더라도 서비스 레이어가 다시 걸러 silent strip 함정을 차단한다.
   */
  async update(id: string, input: UpdateHypothesisInput) {
    const ALLOWED_FIELDS: (keyof UpdateHypothesisInput)[] = [
      'statement', 'metric_definition', 'measure_after',
      'owner_member_id', 'confidence', 'draft_metadata', 'human_accounting',
    ];
    const sanitized: Record<string, unknown> = {};
    for (const key of ALLOWED_FIELDS) {
      if (key in input) sanitized[key] = input[key];
    }
    if (Object.keys(sanitized).length === 0) throw new Error('No valid fields to update');
    return this.repo.update(id, sanitized as UpdateHypothesisInput);
  }

  async transition(id: string, input: HypothesisTransitionInput) {
    return this.repo.transition(id, input);
  }

  async link(id: string, input: HypothesisLinkInput) {
    return this.repo.link(id, input);
  }

  async unlink(id: string, input: HypothesisUnlinkInput) {
    return this.repo.unlink(id, input);
  }

  async archive(id: string) {
    return this.repo.archive(id);
  }

  async draft(input: HypothesisDraftInput) {
    return this.repo.draft(input);
  }
}
