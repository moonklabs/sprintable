import { z } from 'zod/v4';

export const createTaskSchema = z.object({
  story_id: z.string().min(1),
  title: z.string().min(1),
  assignee_id: z.string().optional().nullable(),
  status: z.string().optional(),
});

export const updateTaskSchema = z.object({
  title: z.string().min(1).optional(),
  status: z.string().optional(),
  assignee_id: z.string().optional().nullable(),
});
