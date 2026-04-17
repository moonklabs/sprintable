import { z } from 'zod/v4';

export const createRetroSessionSchema = z.object({
  title: z.string().min(1),
  sprint_id: z.string().optional(),
});
