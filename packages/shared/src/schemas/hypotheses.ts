import { z } from 'zod/v4';
import { metricDefinitionSchema } from './outcome';

// §2.5 상태 7종 (BE HYPOTHESIS_STATUSES와 동기).
export const HYPOTHESIS_STATUSES = [
  'proposed', 'active', 'measuring', 'verified', 'falsified', 'killed', 'archived',
] as const;
// transition endpoint가 허용하는 목표 상태(생성 시 proposed는 별도).
export const HYPOTHESIS_TRANSITION_TARGETS = [
  'active', 'measuring', 'verified', 'falsified', 'killed', 'archived',
] as const;
export const HYPOTHESIS_LINK_TYPES = ['primary', 'supports'] as const;

const hypothesisStatusEnum = z.enum(HYPOTHESIS_STATUSES);

export const createHypothesisSchema = z.object({
  project_id: z.string().min(1),
  statement: z.string().min(1),
  metric_definition: metricDefinitionSchema,
  measure_after: z.string().datetime(),
  owner_member_id: z.string().optional().nullable(),
  status: hypothesisStatusEnum.optional(),
  epic_ids: z.array(z.string()).optional(),
  story_ids: z.array(z.string()).optional(),
  source_type: z.string().optional().nullable(),
  source_id: z.string().optional().nullable(),
  draft_metadata: z.record(z.string(), z.unknown()).optional().nullable(),
});

/**
 * §3.5 update allowlist — `status`/`outcome_result`는 transition endpoint 전용이라 제외.
 * 이 스키마 키는 `HypothesisService.update`의 ALLOWED_FIELDS·core `UpdateHypothesisInput`과
 * 1:1 동기화되어야 한다 (E1-S7 AC① — silent strip 함정 방지).
 */
export const updateHypothesisSchema = z.object({
  statement: z.string().min(1).optional(),
  metric_definition: metricDefinitionSchema.optional(),
  measure_after: z.string().datetime().optional(),
  owner_member_id: z.string().optional().nullable(),
  confidence: z.number().optional().nullable(),
  draft_metadata: z.record(z.string(), z.unknown()).optional().nullable(),
  human_accounting: z.record(z.string(), z.unknown()).optional().nullable(),
});

export const transitionHypothesisSchema = z.object({
  status: z.enum(HYPOTHESIS_TRANSITION_TARGETS),
  note: z.string().optional().nullable(),
  outcome_result: z.record(z.string(), z.unknown()).optional().nullable(),
});

export const linkHypothesisSchema = z.object({
  epic_ids: z.array(z.string()).optional(),
  story_ids: z.array(z.string()).optional(),
  link_type: z.enum(HYPOTHESIS_LINK_TYPES).optional().nullable(),
});

export const unlinkHypothesisSchema = z.object({
  epic_ids: z.array(z.string()).optional(),
  story_ids: z.array(z.string()).optional(),
});

export const draftHypothesisSchema = z.object({
  project_id: z.string().min(1),
  source_type: z.string().min(1),
  // S16 BE 갭(#1850): "loop_goal"은 백킹 엔티티가 없어 source_id 없이 context dict만으로
  // draft — BE model_validator가 "loop_goal 외 source_type은 source_id 필수"를 권위 검증하므로
  // FE는 shape만 optional로 두고 실제 강제는 BE에 위임(기존 4종 회귀 없음, 여전히 값 보내면 통과).
  source_id: z.string().min(1).optional(),
  context: z.record(z.string(), z.unknown()).optional().nullable(),
  // persist=true이면 status='proposed' row 생성(drafted_by_member_id 기록·E1-S10 AC④).
  // 기본 false=미리보기. BE HypothesisDraftRequest.persist와 동기.
  persist: z.boolean().optional(),
});
