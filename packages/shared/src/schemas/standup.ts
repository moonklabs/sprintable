import { z } from 'zod/v4';

export const saveStandupSchema = z.object({
  sprint_id: z.string().optional().nullable(),
  date: z.string().min(1),
  done: z.string().optional().nullable(),
  plan: z.string().optional().nullable(),
  blockers: z.string().optional().nullable(),
  plan_story_ids: z.array(z.string()).optional(),
});

export const createStandupFeedbackSchema = z.object({
  standup_entry_id: z.string().min(1),
  review_type: z.enum(['comment', 'approve', 'request_changes']).optional(),
  feedback_text: z.string().min(1),
});

export const updateStandupFeedbackSchema = z.object({
  review_type: z.enum(['comment', 'approve', 'request_changes']).optional(),
  feedback_text: z.string().min(1).optional(),
});
