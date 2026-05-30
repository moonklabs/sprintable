import { z } from 'zod/v4';

export const metricDefinitionSchema = z.object({
  metric: z.string().min(1),
  source: z.enum(['internal_ops', 'ga4', 'manual']),
  target: z.number(),
  direction: z.enum(['up', 'down']),
});
