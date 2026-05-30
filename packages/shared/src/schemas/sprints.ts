import { z } from 'zod/v4';

const metricDefinitionSchema = z.object({
  metric: z.string().min(1),
  source: z.enum(['internal_ops', 'ga4', 'manual']),
  target: z.number(),
  direction: z.enum(['up', 'down']),
});

export const createSprintSchema = z.object({
  project_id: z.string().min(1),
  org_id: z.string().min(1),
  title: z.string().min(1),
  start_date: z.string().min(1),
  end_date: z.string().min(1),
  team_size: z.number().optional(),
  success_hypothesis: z.string().optional().nullable(),
  metric_definition: metricDefinitionSchema.optional().nullable(),
  measure_after: z.string().datetime().optional().nullable(),
});

export const updateSprintSchema = z.object({
  title: z.string().min(1).optional(),
  start_date: z.string().min(1).optional(),
  end_date: z.string().min(1).optional(),
  team_size: z.number().optional(),
  success_hypothesis: z.string().optional().nullable(),
  metric_definition: metricDefinitionSchema.optional().nullable(),
  measure_after: z.string().datetime().optional().nullable(),
});
