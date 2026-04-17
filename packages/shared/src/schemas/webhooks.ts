import { z } from 'zod/v4';

export const upsertWebhookSchema = z.object({
  member_id: z.string().optional(),
  url: z.string().url(),
  secret: z.string().optional().nullable(),
  events: z.array(z.string()).optional(),
  is_active: z.boolean().optional(),
});
