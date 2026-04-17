import { z } from 'zod/v4';

export const createEpicSchema = z.object({
  project_id: z.string().min(1),
  org_id: z.string().min(1),
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
