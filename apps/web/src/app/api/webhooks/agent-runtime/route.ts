import { createSupabaseAdminClient } from '@/lib/supabase/admin';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SupabaseClient = any;
import { z } from 'zod';
import { apiError, apiSuccess } from '@/lib/api-response';
import { isOssMode } from '@/lib/storage/factory';
import { AgentExecutionLoop } from '@/services/agent-execution-loop';

const routingSchema = z.object({
  rule_id: z.string().uuid(),
  auto_reply_mode: z.enum(['process_and_forward', 'process_and_report']),
  forward_to_agent_id: z.string().uuid().nullable(),
  original_assigned_to: z.string().uuid().nullable(),
  target_runtime: z.string(),
  target_model: z.string().nullable(),
}).superRefine((value, ctx) => {
  if (value.auto_reply_mode === 'process_and_report' && value.forward_to_agent_id) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['forward_to_agent_id'],
      message: 'forward_to_agent_id is only allowed when auto_reply_mode is process_and_forward',
    });
  }

  if (value.auto_reply_mode === 'process_and_forward' && !value.forward_to_agent_id) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['forward_to_agent_id'],
      message: 'process_and_forward requires forward_to_agent_id',
    });
  }
});

const memoAssignedSchema = z.object({
  event: z.literal('memo.assigned'),
  data: z.object({
    run_id: z.string().uuid(),
    memo_id: z.string().uuid(),
    project_id: z.string().uuid(),
    org_id: z.string().uuid(),
    agent_id: z.string().uuid(),
    routing: routingSchema.nullable().optional(),
  }),
});

const retryRequestedSchema = z.object({
  event: z.literal('agent_run.retry_requested'),
  data: z.object({
    new_run_id: z.string().uuid(),
    original_run_id: z.string().uuid().optional(),
    memo_id: z.string().uuid().nullable().optional(),
    agent_id: z.string().uuid(),
  }),
});

const payloadSchema = z.union([memoAssignedSchema, retryRequestedSchema]);

async function resolveWebhookScope(supabase: SupabaseClient, payload: z.infer<typeof payloadSchema>) {
  if (payload.event === 'memo.assigned') {
    return {
      runId: payload.data.run_id,
      memoId: payload.data.memo_id,
      orgId: payload.data.org_id,
      projectId: payload.data.project_id,
      agentId: payload.data.agent_id,
      originalRunId: undefined,
      routing: payload.data.routing ? {
        ruleId: payload.data.routing.rule_id,
        autoReplyMode: payload.data.routing.auto_reply_mode,
        forwardToAgentId: payload.data.routing.forward_to_agent_id,
        originalAssignedTo: payload.data.routing.original_assigned_to,
        targetRuntime: payload.data.routing.target_runtime,
        targetModel: payload.data.routing.target_model,
      } : undefined,
    };
  }

  const runResult = await supabase
    .from('agent_runs')
    .select('id, org_id, project_id, memo_id, agent_id')
    .eq('id', payload.data.new_run_id)
    .single();
  const run = runResult.data as { id: string; org_id: string; project_id: string; memo_id: string | null; agent_id: string } | null;

  if (runResult.error || !run) {
    throw new Error('retry_run_not_found');
  }

  const memoId = (run.memo_id as string | null) ?? payload.data.memo_id;
  if (!memoId) {
    throw new Error('retry_run_memo_missing');
  }

  return {
    runId: run.id as string,
    memoId,
    orgId: run.org_id as string,
    projectId: run.project_id as string,
    agentId: run.agent_id as string,
    originalRunId: payload.data.original_run_id,
    routing: undefined,
  };
}

async function validateWebhookSecret(
  supabase: SupabaseClient,
  orgId: string,
  projectId: string,
  agentId: string,
  presentedSecret: string | null,
) {
  const projectConfigResult = await supabase
    .from('webhook_configs')
    .select('secret')
    .eq('org_id', orgId)
    .eq('member_id', agentId)
    .eq('project_id', projectId)
    .eq('is_active', true)
    .maybeSingle();
  const projectConfig = projectConfigResult.data as { secret: string | null } | null;

  const defaultConfigResult = await supabase
    .from('webhook_configs')
    .select('secret')
    .eq('org_id', orgId)
    .eq('member_id', agentId)
    .is('project_id', null)
    .eq('is_active', true)
    .maybeSingle();
  const defaultConfig = defaultConfigResult.data as { secret: string | null } | null;

  const secret = projectConfig?.secret ?? defaultConfig?.secret;

  if (!secret) {
    return true;
  }

  return presentedSecret === secret;
}

export async function POST(request: Request) {
  if (isOssMode()) return apiError('NOT_AVAILABLE', 'Not available in OSS mode.', 503);
  const supabase = createSupabaseAdminClient();

  try {
    const payloadResult = payloadSchema.safeParse(await request.json());
    if (!payloadResult.success) {
      return apiError('BAD_REQUEST', payloadResult.error.issues.map((issue) => issue.message).join(', '), 400);
    }

    const payload = payloadResult.data;
    const scope = await resolveWebhookScope(supabase, payload);
    const presentedSecret = request.headers.get('x-webhook-secret');
    const secretValid = await validateWebhookSecret(supabase, scope.orgId, scope.projectId, scope.agentId, presentedSecret);
    if (!secretValid) {
      return apiError('UNAUTHORIZED', 'Invalid webhook secret', 401);
    }

    const loop = new AgentExecutionLoop(supabase as never);
    const result = await loop.execute({
      runId: scope.runId,
      memoId: scope.memoId,
      orgId: scope.orgId,
      projectId: scope.projectId,
      agentId: scope.agentId,
      triggerEvent: payload.event,
      originalRunId: scope.originalRunId,
      routing: scope.routing,
    });

    return apiSuccess(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Webhook execution failed';
    return apiError('WEBHOOK_ERROR', message, 400);
  }
}
