import { z } from 'zod/v4';

// ─── Memo ────────────────────────────────────
export const MEMO_TYPES = [
  'memo', 'task', 'checklist', 'decision', 'request', 'handoff',
  'feedback', 'announcement', 'general', 'system_workflow_update',
] as const;

export const MEMO_TYPES_REQUIRING_ASSIGNEE = ['task', 'request', 'feedback'] as const;

export const createMemoSchema = z.object({
  title: z.string().optional().nullable(),
  content: z.string().min(1),
  memo_type: z.enum(MEMO_TYPES).optional(),
  assigned_to: z.string().optional().nullable(), // DEPRECATED: use assigned_to_ids
  assigned_to_ids: z.array(z.string()).optional(), // New: supports multiple assignees
  supersedes_id: z.string().optional().nullable(),
  trigger_type: z.string().optional().nullable(),
});

// ─── Core Write APIs ──────────────────────────
const orgRoleSchema = z.enum(['owner', 'admin', 'member']);
const teamMemberTypeSchema = z.enum(['human', 'agent']);

export const createProjectSchema = z.object({
  org_id: z.string().trim().min(1),
  name: z.string().trim().min(1),
  description: z.string().optional().nullable(),
});

export const createInvitationSchema = z.object({
  email: z.string().trim().email(),
  project_id: z.string().trim().min(1).optional().nullable(),
  role: orgRoleSchema.optional().default('member'),
});

export const acceptInvitationSchema = z.object({
  token: z.string().trim().min(1),
});

export const createTeamMemberSchema = z.object({
  project_id: z.string().trim().min(1).optional().nullable(),
  type: teamMemberTypeSchema.optional().default('human'),
  user_id: z.string().trim().min(1).optional().nullable(),
  name: z.string().trim().min(1).optional().nullable(),
  role: z.string().trim().min(1).optional().default('member'),
  agent_config: z.record(z.string(), z.unknown()).optional().nullable(),
  webhook_url: z.string().url().startsWith('https://').optional().nullable(),
}).superRefine((value, ctx) => {
  if (value.type === 'human' && !value.user_id) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['user_id'],
      message: 'user_id required for human member',
    });
  }

  if (value.type === 'agent' && !value.name) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['name'],
      message: 'name required for agent member',
    });
  }
});

export const setCurrentProjectSchema = z.object({
  project_id: z.string().trim().min(1),
});

export const updateNotificationSchema = z.object({
  markAllRead: z.boolean().optional(),
  type: z.string().trim().min(1).optional(),
  id: z.string().trim().min(1).optional(),
  is_read: z.boolean().optional(),
}).superRefine((value, ctx) => {
  if (!value.markAllRead && !value.id) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['id'],
      message: 'id required when markAllRead is false',
    });
  }
});

export const createMemoReplySchema = z.object({
  content: z.string().min(1),
  assigned_to: z.string().optional().describe('Single team member ID to notify via webhook (legacy, use assigned_to_ids for multiple)'),
  assigned_to_ids: z.array(z.string()).optional().describe('Team member IDs to explicitly notify via webhook on this reply'),
});

export const createMemoLinkedDocSchema = z.object({
  doc_id: z.string().optional(),
  title: z.string().optional(),
  content: z.string().optional(),
  content_format: z.enum(['markdown', 'html']).optional(),
});

// ─── Epic ────────────────────────────────────
// story #2863(P0, 긴급) — 이 자리에 독립 정의된 구판(4필드뿐, assignee_id 등 8개 필드
// 누락)이 epics.ts의 실제 최신판을 export 체인에서 완전히 가렸다(epics.ts는 어디서도
// re-export 안 됨 — 도달 불가능한 죽은 코드였음). zod가 미인식 키를 조용히 strip해
// PATCH /api/goals/{id}(assignee_id)가 200+무반영이었던 근본원인. updateHypothesisSchema
// 처럼 실 정의 파일을 그대로 재노출(정의 중복 0)하는 형태로 통일한다.
export { createEpicSchema, updateEpicSchema, EPIC_STATUSES } from './epics';

// ─── Sprint ──────────────────────────────────
// story #2863(P0) 스윕 — epics와 동일 클래스(지역 재정의가 sprints.ts를 죽은 코드로 가려
// success_hypothesis/metric_definition/measure_after가 조용히 drop되고 있었다). sprints.ts로
// 필드 합집합 병합 후 재노출로 통일.
export { createSprintSchema, updateSprintSchema } from './sprints';

// ─── Story ───────────────────────────────────
export { createStorySchema, updateStorySchema, bulkUpdateStoriesSchema as bulkUpdateStorySchema, VALID_STORY_TRANSITIONS, STORY_STATUSES, STORY_PRIORITIES, STORY_SP_VALUES } from './stories';
export {
  createHypothesisSchema,
  hypothesisGuidedCreateSchema,
  updateHypothesisSchema,
  transitionHypothesisSchema,
  linkHypothesisSchema,
  unlinkHypothesisSchema,
  draftHypothesisSchema,
  HYPOTHESIS_STATUSES,
  HYPOTHESIS_TRANSITION_TARGETS,
  HYPOTHESIS_LINK_TYPES,
} from './hypotheses';

// ─── Task ────────────────────────────────────
export const TASK_STATUSES = ['todo', 'in-progress', 'done'] as const;

export const createTaskSchema = z.object({
  story_id: z.string().min(1),
  title: z.string().min(1),
  assignee_id: z.string().optional().nullable(),
  status: z.enum(TASK_STATUSES).optional(),
  story_points: z.number().optional().nullable(),
});

export const updateTaskSchema = z.object({
  title: z.string().min(1).optional(),
  status: z.enum(TASK_STATUSES).optional(),
  assignee_id: z.string().optional().nullable(),
  story_points: z.number().optional().nullable(),
});

// ─── Doc ─────────────────────────────────────
// story #2863(P0) 스윕 — epics와 동일 클래스(지역 재정의가 docs.ts를 죽은 코드로 가림).
// docs.ts로 필드 합집합 병합 후 재노출로 통일(docCommentSchema는 기존 공개 이름 보존을
// 위해 createDocCommentSchema로 별칭).
export { createDocSchema, updateDocSchema, docCommentSchema as createDocCommentSchema } from './docs';

// ─── Standup ─────────────────────────────────
export const saveStandupSchema = z.object({
  sprint_id: z.string().optional().nullable(),
  date: z.string().min(1),
  done: z.string().optional().nullable(),
  plan: z.string().optional().nullable(),
  blockers: z.string().optional().nullable(),
  plan_story_ids: z.array(z.string()).optional(),
});

export const createStandupFeedbackSchema = z.object({
  standup_entry_id: z.string().min(1),
  review_type: z.enum(['comment', 'approve', 'request_changes']).optional(),
  feedback_text: z.string().min(1),
});

export const updateStandupFeedbackSchema = z.object({
  review_type: z.enum(['comment', 'approve', 'request_changes']).optional(),
  feedback_text: z.string().min(1).optional(),
});

// ─── Retro ───────────────────────────────────
export const createRetroSchema = z.object({
  project_id: z.string().optional(),
  sprint_id: z.string().min(1).optional().nullable(),
  title: z.string().min(1),
});

// ─── Rewards ─────────────────────────────────
export const createRewardSchema = z.object({
  member_id: z.string().min(1),
  amount: z.number(),
  reason: z.string().min(1),
  reference_type: z.string().optional(),
  reference_id: z.string().optional(),
});

// ─── Notification Settings ───────────────────
export const updateNotificationSettingsSchema = z.object({
  channel: z.string().min(1),
  event_type: z.string().min(1),
  enabled: z.boolean(),
});

// ─── Sprint Close ────────────────────────────
export const closeSprintSchema = z.object({
  next_sprint_id: z.string().optional().nullable(),
});

// ─── Mockup ──────────────────────────────────
const viewportEnum = z.enum(['mobile', 'desktop']);

export const createMockupPageSchema = z.object({
  slug: z.string().min(1),
  title: z.string().min(1),
  category: z.string().optional(),
  viewport: viewportEnum.optional(),
});

export const updateMockupPageSchema = z.object({
  title: z.string().min(1).optional(),
  slug: z.string().min(1).optional(),
  category: z.string().optional(),
  viewport: viewportEnum.optional(),
  components: z.array(z.object({
    id: z.string().optional(),
    parent_id: z.string().optional().nullable(),
    component_type: z.string().min(1),
    props: z.record(z.string(), z.unknown()).optional(),
    spec_description: z.string().optional().nullable(),
    sort_order: z.number().optional(),
  })).optional(),
});
// ─── Messaging Bridge ───────────────────────
const bridgePlatformEnum = z.enum(['slack', 'discord', 'teams', 'telegram']);
const bridgeSecretRefPattern = /^(env|vault):\S+$/;

export const bridgeSecretRefSchema = z
  .string()
  .min(1)
  .regex(bridgeSecretRefPattern, 'config values must use env: or vault: secret references');

export const bridgeSecretConfigSchema = z.record(z.string(), bridgeSecretRefSchema);

export const createBridgeChannelSchema = z.object({
  project_id: z.string().min(1),
  platform: bridgePlatformEnum,
  channel_id: z.string().min(1),
  channel_name: z.string().optional().nullable(),
  config: bridgeSecretConfigSchema.optional(),
});

export const updateBridgeChannelSchema = z.object({
  channel_name: z.string().optional().nullable(),
  config: bridgeSecretConfigSchema.optional(),
  is_active: z.boolean().optional(),
});

export const createBridgeUserSchema = z.object({
  team_member_id: z.string().min(1),
  platform: bridgePlatformEnum,
  platform_user_id: z.string().min(1),
  display_name: z.string().optional().nullable(),
});

export const updateBridgeUserSchema = z.object({
  display_name: z.string().optional().nullable(),
  is_active: z.boolean().optional(),
});

export * from './meetings';
export * from './inbox';
