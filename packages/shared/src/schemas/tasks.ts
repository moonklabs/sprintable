import { z } from 'zod/v4';

export const updateTaskSchema = z.object({
  title: z.string().min(1).optional(),
  status: z.string().optional(),
  assignee_id: z.string().optional().nullable(),
});
