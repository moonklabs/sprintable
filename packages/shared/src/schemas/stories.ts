import { z } from 'zod/v4';

export const STORY_STATUSES = ['backlog', 'ready-for-dev', 'in-progress', 'in-review', 'done'] as const;
export const STORY_PRIORITIES = ['critical', 'high', 'medium', 'low'] as const;
export const STORY_SP_VALUES = [1, 2, 3, 5, 8, 13, 21] as const;

/**
 * 유효한 스토리 상태 전이 맵 (단일 소스)
 * done→in-review는 admin만 허용 — 백엔드 StoryService에서 별도 체크
 */
export const VALID_STORY_TRANSITIONS: Record<string, string[]> = {
  backlog: ['ready-for-dev'],
  'ready-for-dev': ['in-progress', 'backlog'],
  'in-progress': ['in-review', 'ready-for-dev'],
  'in-review': ['done', 'in-progress'],
  done: ['in-review'],
};

const storyStatusEnum = z.enum(STORY_STATUSES);
const storyPriorityEnum = z.enum(STORY_PRIORITIES);
const storySpSchema = z.union([
  z.literal(1), z.literal(2), z.literal(3), z.literal(5),
  z.literal(8), z.literal(13), z.literal(21),
]);

export const createStorySchema = z.object({
  project_id: z.string().min(1),
  org_id: z.string().min(1),
  title: z.string().min(1),
  epic_id: z.string().optional().nullable(),
  sprint_id: z.string().optional().nullable(),
  assignee_id: z.string().optional().nullable(),
  status: storyStatusEnum.optional(),
  priority: storyPriorityEnum.optional(),
  story_points: storySpSchema.optional().nullable(),
  description: z.string().optional().nullable(),
  acceptance_criteria: z.string().optional().nullable(),
  meeting_id: z.string().uuid().optional().nullable(),
});

export const updateStorySchema = z.object({
  title: z.string().min(1).optional(),
  status: storyStatusEnum.optional(),
  priority: storyPriorityEnum.optional(),
  story_points: storySpSchema.optional().nullable(),
  description: z.string().optional().nullable(),
  acceptance_criteria: z.string().optional().nullable(),
  epic_id: z.string().optional().nullable(),
  sprint_id: z.string().optional().nullable(),
  assignee_id: z.string().optional().nullable(),
});

const bulkUpdateItemSchema = z.object({
  id: z.string().min(1),
  status: storyStatusEnum.optional(),
  sprint_id: z.string().optional().nullable(),
  assignee_id: z.string().optional().nullable(),
});

export const bulkUpdateStoriesSchema = z.object({
  items: z.array(bulkUpdateItemSchema).min(1),
});
