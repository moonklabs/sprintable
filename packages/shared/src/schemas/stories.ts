import { z } from 'zod/v4';

const storyStatusEnum = z.enum(['backlog', 'ready-for-dev', 'in-progress', 'in-review', 'done']);

export const createStorySchema = z.object({
  project_id: z.string().min(1),
  org_id: z.string().min(1),
  title: z.string().min(1),
  epic_id: z.string().optional().nullable(),
  sprint_id: z.string().optional().nullable(),
  assignee_id: z.string().optional().nullable(),
  status: storyStatusEnum.optional(),
  priority: z.string().optional(),
  story_points: z.number().optional().nullable(),
  description: z.string().optional().nullable(),
  meeting_id: z.string().uuid().optional().nullable(),
});

export const updateStorySchema = z.object({
  title: z.string().min(1).optional(),
  status: storyStatusEnum.optional(),
  priority: z.string().optional(),
  story_points: z.number().optional().nullable(),
  description: z.string().optional().nullable(),
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
