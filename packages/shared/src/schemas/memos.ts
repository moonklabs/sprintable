import { z } from 'zod/v4';

export const createMemoSchema = z.object({
  title: z.string().optional().nullable(),
  content: z.string().min(1),
  memo_type: z.string().optional(),
  assigned_to: z.string().optional().nullable(), // DEPRECATED: use assigned_to_ids
  assigned_to_ids: z.array(z.string()).optional(), // New: supports multiple assignees
  supersedes_id: z.string().optional().nullable(),
});

export const memoReplySchema = z.object({
  content: z.string().min(1),
});

export const memoLinkedDocSchema = z.object({
  doc_id: z.string().optional(),
  title: z.string().optional(),
  content: z.string().optional(),
  content_format: z.enum(['markdown', 'html']).optional(),
});
