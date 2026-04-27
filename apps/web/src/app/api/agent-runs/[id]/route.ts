import { z } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { handleApiError } from '@/lib/api-error';
import { getAuthContext } from '@/lib/auth-helpers';
import { apiSuccess, ApiErrors } from '@/lib/api-response';
import { AgentRunService } from '@/services/agent-run';
import { InboxItemService } from '@/services/inbox-item.service';
import { originChainSchema, inboxOptionsSchema, INBOX_PRIORITIES } from '@sprintable/shared';

type RouteParams = { params: Promise<{ id: string }> };

// Optional inbox emit on agent_run completion (Phase A.5b producer #1).
// When the agent run transitions to status='completed' AND `inbox` is present,
// we emit an inbox_items row for HITL approval. Idempotent via UNIQUE constraint
// (org_id, source_type='agent_run', source_id=run.id, kind=approval).
const inboxOnCompletionSchema = z.object({
  assignee_member_id: z.string().min(1),
  title: z.string().min(1).max(200),
  context: z.string().max(2000).optional().nullable(),
  agent_summary: z.string().max(2000).optional().nullable(),
  options: inboxOptionsSchema.default([]),
  after_decision: z.string().max(500).optional().nullable(),
  origin_chain: originChainSchema.optional(),
  story_id: z.string().optional().nullable(),
  memo_id: z.string().optional().nullable(),
  priority: z.enum(INBOX_PRIORITIES).optional(),
  kind: z.enum(['approval', 'decision', 'blocker'] as const).optional().default('approval'),
});

const updateAgentRunSchema = z.object({
  status: z.enum(['running', 'completed', 'failed']),
  error_message: z.string().optional().nullable(),
  result_summary: z.string().optional().nullable(),
  input_tokens: z.number().optional().nullable(),
  output_tokens: z.number().optional().nullable(),
  cost_usd: z.number().optional().nullable(),
  started_at: z.string().optional().nullable(),
  finished_at: z.string().optional().nullable(),
  inbox: inboxOnCompletionSchema.optional(),
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
    const { inbox: inboxRequest, ...updateInput } = body;
    const run = await service.update(id, updateInput, existing.org_id, existing.project_id);

    // Producer #1 — agent_runs lifecycle hook → inbox approval.
    // Emit inbox only when the run transitions to a successful terminal state AND
    // caller explicitly attached `inbox` payload. Failure here must not roll back
    // the run update — idempotent UNIQUE constraint protects against retries.
    if (inboxRequest && body.status === 'completed') {
      try {
        const inboxService = new InboxItemService(dbClient);
        await inboxService.create({
          org_id: existing.org_id,
          project_id: existing.project_id,
          assignee_member_id: inboxRequest.assignee_member_id,
          kind: inboxRequest.kind ?? 'approval',
          title: inboxRequest.title,
          context: inboxRequest.context ?? null,
          agent_summary: inboxRequest.agent_summary ?? null,
          options: inboxRequest.options,
          after_decision: inboxRequest.after_decision ?? null,
          origin_chain: inboxRequest.origin_chain ?? [{ type: 'run', id }],
          story_id: inboxRequest.story_id ?? null,
          memo_id: inboxRequest.memo_id ?? null,
          priority: inboxRequest.priority ?? 'normal',
          source_type: 'agent_run',
          source_id: id,
        });
      } catch (err: unknown) {
        console.error('[agent-runs PATCH] inbox emit failed', err);
      }
    }

    return apiSuccess(run);
  } catch (err: unknown) {
    return handleApiError(err);
  }
}
