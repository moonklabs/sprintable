import { z } from 'zod/v4';

export const EPIC_STATUSES = ['draft', 'active', 'done', 'archived'] as const;

export const createEpicSchema = z.object({
  project_id: z.string().min(1),
  org_id: z.string().min(1),
  title: z.string().min(1),
  status: z.enum(EPIC_STATUSES).optional(),
  priority: z.string().optional(),
  description: z.string().optional().nullable(),
  objective: z.string().optional().nullable(),
  success_criteria: z.string().optional().nullable(),
  target_sp: z.number().int().positive().optional().nullable(),
  target_date: z.string().optional().nullable(),
});

export const updateEpicSchema = z.object({
  title: z.string().min(1).optional(),
  status: z.enum(EPIC_STATUSES).optional(),
  priority: z.string().optional(),
  description: z.string().optional().nullable(),
  objective: z.string().optional().nullable(),
  success_criteria: z.string().optional().nullable(),
  target_sp: z.number().int().positive().optional().nullable(),
  target_date: z.string().optional().nullable(),
});
