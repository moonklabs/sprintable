import { z } from 'zod/v4';

// story #2863(P0) 스윕 — index.ts에 독립 재정의돼 있던 구판(slug_locked·sort_order 누락)이
// export 체인에서 이 파일을 가려 죽은 코드로 만들었다(같은 근본원인의 자매 인스턴스). 여기
// 하나로 합치되, index.ts live판이 실제로 통과시키던 관용도(slug optional·parent_id
// nullable)는 그대로 보존하고, 양쪽에 각자만 있던 필드(slug_locked/sort_order ↔
// expected_updated_at/force_overwrite)는 합집합으로 유지한다(어느 쪽도 새로 자르지 않음).
export const createDocSchema = z.object({
  title: z.string().min(1),
  slug: z.string().optional(),
  content: z.string().optional(),
  content_format: z.enum(['markdown', 'html']).optional(),
  icon: z.string().optional().nullable(),
  tags: z.array(z.string()).optional(),
  parent_id: z.string().optional().nullable(),
  is_folder: z.boolean().optional(),
});

export const updateDocSchema = z.object({
  title: z.string().min(1).optional(),
  slug: z.string().optional(),
  slug_locked: z.boolean().optional(),
  content: z.string().optional(),
  content_format: z.enum(['markdown', 'html']).optional(),
  icon: z.string().optional().nullable(),
  tags: z.array(z.string()).optional(),
  sort_order: z.number().optional(),
  parent_id: z.string().optional().nullable(),
  expected_updated_at: z.string().optional(),
  force_overwrite: z.boolean().optional(),
});

export const docCommentSchema = z.object({
  content: z.string().min(1),
});
