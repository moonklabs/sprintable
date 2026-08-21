import { z } from 'zod/v4';
import { metricDefinitionSchema } from './outcome';

// story #2863(P0) 스윕 — epics와 동일 클래스. index.ts live판이 실제로 통과시키던 관용도
// (project_id/org_id optional·team_size int-positive)는 보존하고, 이 파일에만 있던
// outcome 3필드(success_hypothesis/metric_definition/measure_after — E-BOARD-SCHEMA 의도
// 필드, live판에서 누락돼 조용히 drop되고 있었다)를 합친다.
export const createSprintSchema = z.object({
  project_id: z.string().min(1).optional(),
  org_id: z.string().min(1).optional(),
  title: z.string().min(1),
  start_date: z.string().min(1),
  end_date: z.string().min(1),
  team_size: z.number().int().positive().optional(),
  success_hypothesis: z.string().optional().nullable(),
  metric_definition: metricDefinitionSchema.optional().nullable(),
  measure_after: z.string().datetime().optional().nullable(),
});

export const updateSprintSchema = z.object({
  title: z.string().min(1).optional(),
  start_date: z.string().optional(),
  end_date: z.string().optional(),
  team_size: z.number().int().positive().optional(),
  success_hypothesis: z.string().optional().nullable(),
  metric_definition: metricDefinitionSchema.optional().nullable(),
  measure_after: z.string().datetime().optional().nullable(),
});
