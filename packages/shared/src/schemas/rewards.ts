import { z } from 'zod/v4';

export const grantRewardSchema = z.object({
  member_id: z.string().min(1),
  amount: z.number(),
  reason: z.string().min(1),
  reference_type: z.string().optional(),
  reference_id: z.string().optional(),
});
