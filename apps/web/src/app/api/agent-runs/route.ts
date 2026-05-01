import { z } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { handleApiError } from '@/lib/api-error';
import { getAuthContext } from '@/lib/auth-helpers';
import { apiSuccess, ApiErrors } from '@/lib/api-response';
import { AgentRunService } from '@/services/agent-run';
import { requireAgentScope } from '@/lib/auth-api-key';

const createAgentRunSchema = z.object({
  agent_id: z.string().min(1),
  trigger: z.string().min(1),
  model: z.string().optional().nullable(),
  story_id: z.string().optional().nullable(),
  memo_id: z.string().optional().nullable(),
  result_summary: z.string().optional().nullable(),
  status: z.enum(['running', 'completed', 'failed']).optional(),
  error_message: z.string().optional().nullable(),
  input_tokens: z.number().optional().nullable(),
  output_tokens: z.number().optional().nullable(),
  started_at: z.string().optional().nullable(),
  finished_at: z.string().optional().nullable(),
});

// POST /api/agent-runs
export async function POST(request: Request) {
  try {
    const supabase = await createSupabaseServerClient();
    const me = await getAuthContext(supabase, request);
    if (!me) return ApiErrors.unauthorized();
    if (me.rateLimitExceeded) return ApiErrors.tooManyRequests(me.rateLimitRemaining, me.rateLimitResetAt);

    if (!requireAgentScope(me, 'write')) return ApiErrors.insufficientScope('write');

    const dbClient: SupabaseClient = me.type === 'agent' ? createSupabaseAdminClient() : supabase;

    let rawBody: unknown;
    try { rawBody = await request.json(); } catch { return ApiErrors.badRequest('Invalid JSON body'); }

    const parsed = createAgentRunSchema.safeParse(rawBody);
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i: z.core.$ZodIssue) => ({ path: i.path.join('.'), message: i.message }));
      return ApiErrors.validationFailed(issues);
    }
    const body = parsed.data;

    const { data: member, error: memberError } = await dbClient
      .from('team_members')
      .select('project_id, org_id')
      .eq('id', body.agent_id)
      .single();
    if (memberError || !member) return ApiErrors.badRequest('agent_id not found');

    const service = new AgentRunService(dbClient);
    const run = await service.create({
      org_id: member.org_id,
      project_id: member.project_id,
      agent_id: body.agent_id,
      trigger: body.trigger,
      model: body.model,
      story_id: body.story_id,
      memo_id: body.memo_id,
      result_summary: body.result_summary,
      status: body.status,
      error_message: body.error_message,
      input_tokens: body.input_tokens,
      output_tokens: body.output_tokens,
      started_at: body.started_at,
      finished_at: body.finished_at,
    });
    return apiSuccess(run, undefined, 201);
  } catch (err: unknown) {
    return handleApiError(err);
  }
}

// GET /api/agent-runs?project_id=X&limit=N
export async function GET(request: Request) {
  try {
    const supabase = await createSupabaseServerClient();
    const me = await getAuthContext(supabase, request);
    if (!me) return ApiErrors.unauthorized();
    if (me.rateLimitExceeded) return ApiErrors.tooManyRequests(me.rateLimitRemaining, me.rateLimitResetAt);

    const { searchParams } = new URL(request.url);
    const projectId = searchParams.get('project_id');
    if (!projectId) return ApiErrors.badRequest('project_id required');
    const limit = searchParams.get('limit');
    const agentId = searchParams.get('agent_id') ?? undefined;
    const cursor = searchParams.get('cursor') ?? undefined;

    const dbClient: SupabaseClient = me.type === 'agent' ? createSupabaseAdminClient() : supabase;
    const service = new AgentRunService(dbClient);
    const runs = await service.list(projectId, limit ? Number(limit) : undefined, agentId, cursor);
    return apiSuccess(runs);
  } catch (err: unknown) {
    return handleApiError(err);
  }
}
