import { z } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { handleApiError } from '@/lib/api-error';
import { getAuthContext } from '@/lib/auth-helpers';
import { apiSuccess, ApiErrors } from '@/lib/api-response';
import { AgentRunService } from '@/services/agent-run';

type RouteParams = { params: Promise<{ id: string }> };

const updateAgentRunSchema = z.object({
  status: z.enum(['running', 'completed', 'failed']),
  error_message: z.string().optional().nullable(),
  result_summary: z.string().optional().nullable(),
  input_tokens: z.number().optional().nullable(),
  output_tokens: z.number().optional().nullable(),
  cost_usd: z.number().optional().nullable(),
  started_at: z.string().optional().nullable(),
  finished_at: z.string().optional().nullable(),
});

// PATCH /api/agent-runs/[id]
export async function PATCH(request: Request, { params }: RouteParams) {
  try {
    const { id } = await params;
    const supabase = await createSupabaseServerClient();
    const me = await getAuthContext(supabase, request);
    if (!me) return ApiErrors.unauthorized();
    if (me.rateLimitExceeded) return ApiErrors.tooManyRequests(me.rateLimitRemaining, me.rateLimitResetAt);

    const dbClient: SupabaseClient = me.type === 'agent' ? createSupabaseAdminClient() : supabase;

    // look up existing run to get project_id + org_id for scoping
    const { data: existing, error: existingError } = await dbClient
      .from('agent_runs')
      .select('id, org_id, project_id')
      .eq('id', id)
      .single();
    if (existingError || !existing) return ApiErrors.notFound('Agent run not found');

    let rawBody: unknown;
    try { rawBody = await request.json(); } catch { return ApiErrors.badRequest('Invalid JSON body'); }

    const parsed = updateAgentRunSchema.safeParse(rawBody);
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i: z.core.$ZodIssue) => ({ path: i.path.join('.'), message: i.message }));
      return ApiErrors.validationFailed(issues);
    }
    const body = parsed.data;

    const service = new AgentRunService(dbClient);
    const run = await service.update(id, body, existing.org_id, existing.project_id);
    return apiSuccess(run);
  } catch (err: unknown) {
    return handleApiError(err);
  }
}
