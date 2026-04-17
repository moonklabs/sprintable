import { z } from 'zod/v4';

export const createDocSchema = z.object({
  title: z.string().min(1),
  slug: z.string().min(1),
  content: z.string().optional(),
  content_format: z.enum(['markdown', 'html']).optional(),
  icon: z.string().optional().nullable(),
  tags: z.array(z.string()).optional(),
  parent_id: z.string().optional(),
  is_folder: z.boolean().optional(),
});

export const updateDocSchema = z.object({
  title: z.string().min(1).optional(),
  content: z.string().optional(),
  content_format: z.enum(['markdown', 'html']).optional(),
  icon: z.string().optional().nullable(),
  tags: z.array(z.string()).optional(),
  sort_order: z.number().optional(),
});

export const docCommentSchema = z.object({
  content: z.string().min(1),
});
