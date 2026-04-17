import { z } from 'zod';

export const meetingTypeSchema = z.enum(['standup', 'retro', 'general', 'review']);

export const decisionSchema = z.object({
  id: z.string(),
  text: z.string(),
  owner: z.string().optional(),
  linked_story_id: z.string().uuid().nullable().optional(),
});

export const actionItemSchema = z.object({
  id: z.string(),
  text: z.string(),
  assignee: z.string().optional(),
  due_date: z.string().optional(),
  status: z.enum(['open', 'done']).optional().default('open'),
});

export const createMeetingSchema = z.object({
  title: z.string().min(1).max(200),
  meeting_type: meetingTypeSchema.optional().default('general'),
  date: z.string().datetime().optional(),
  duration_min: z.number().int().positive().optional(),
  participants: z.array(z.unknown()).optional().default([]),
  raw_transcript: z.string().optional(),
  ai_summary: z.string().optional(),
  decisions: z.array(decisionSchema).optional().default([]),
  action_items: z.array(actionItemSchema).optional().default([]),
});

export const updateMeetingSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  meeting_type: meetingTypeSchema.optional(),
  date: z.string().datetime().optional(),
  duration_min: z.number().int().positive().nullable().optional(),
  participants: z.array(z.unknown()).optional(),
  raw_transcript: z.string().nullable().optional(),
  ai_summary: z.string().nullable().optional(),
  decisions: z.array(decisionSchema).optional(),
  action_items: z.array(actionItemSchema).optional(),
});
