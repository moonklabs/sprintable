import { z } from 'zod/v4';

// ─── Memo ────────────────────────────────────
export const createMemoSchema = z.object({
  title: z.string().optional().nullable(),
  content: z.string().min(1),
  memo_type: z.string().optional(),
  assigned_to: z.string().optional().nullable(), // DEPRECATED: use assigned_to_ids
  assigned_to_ids: z.array(z.string()).optional(), // New: supports multiple assignees
  supersedes_id: z.string().optional().nullable(),
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
});

export const createMemoLinkedDocSchema = z.object({
  doc_id: z.string().optional(),
  title: z.string().optional(),
  content: z.string().optional(),
  content_format: z.enum(['markdown', 'html']).optional(),
});

// ─── Epic ────────────────────────────────────
export const createEpicSchema = z.object({
  project_id: z.string().min(1).optional(),
  org_id: z.string().min(1).optional(),
  title: z.string().min(1),
  status: z.string().optional(),
  priority: z.string().optional(),
  description: z.string().optional().nullable(),
});

export const updateEpicSchema = z.object({
  title: z.string().min(1).optional(),
  status: z.string().optional(),
  priority: z.string().optional(),
  description: z.string().optional().nullable(),
});

// ─── Sprint ──────────────────────────────────
export const createSprintSchema = z.object({
  project_id: z.string().min(1).optional(),
  org_id: z.string().min(1).optional(),
  title: z.string().min(1),
  start_date: z.string().min(1),
  end_date: z.string().min(1),
  team_size: z.number().int().positive().optional(),
});

export const updateSprintSchema = z.object({
  title: z.string().min(1).optional(),
  start_date: z.string().optional(),
  end_date: z.string().optional(),
  team_size: z.number().int().positive().optional(),
});

// ─── Story ───────────────────────────────────
export { createStorySchema, updateStorySchema, bulkUpdateStoriesSchema as bulkUpdateStorySchema, VALID_STORY_TRANSITIONS, STORY_STATUSES, STORY_PRIORITIES, STORY_SP_VALUES } from './stories';

// ─── Task ────────────────────────────────────
export const createTaskSchema = z.object({
  story_id: z.string().min(1),
  title: z.string().min(1),
  assignee_id: z.string().optional().nullable(),
  status: z.string().optional(),
  story_points: z.number().optional().nullable(),
});

export const updateTaskSchema = z.object({
  title: z.string().min(1).optional(),
  status: z.string().optional(),
  assignee_id: z.string().optional().nullable(),
  story_points: z.number().optional().nullable(),
});

// ─── Doc ─────────────────────────────────────
export const createDocSchema = z.object({
  title: z.string().min(1),
  slug: z.string().optional(),
  content: z.string().optional(),
  content_format: z.enum(['markdown', 'html']).optional(),
  icon: z.string().optional().nullable(),
  tags: z.array(z.string()).optional(),
  parent_id: z.string().optional().nullable(),
  is_folder: z.boolean().optional(),
});

export const updateDocSchema = z.object({
  title: z.string().min(1).optional(),
  slug: z.string().optional(),
  content: z.string().optional(),
  content_format: z.enum(['markdown', 'html']).optional(),
  icon: z.string().optional().nullable(),
  tags: z.array(z.string()).optional(),
  parent_id: z.string().optional().nullable(),
  expected_updated_at: z.string().optional(),
  force_overwrite: z.boolean().optional(),
});

export const createDocCommentSchema = z.object({
  content: z.string().min(1),
});

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
