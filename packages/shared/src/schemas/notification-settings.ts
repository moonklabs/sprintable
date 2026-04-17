import { z } from 'zod/v4';

export const updateNotificationSettingSchema = z.object({
  channel: z.string().min(1),
  event_type: z.string().min(1),
  enabled: z.boolean(),
});
