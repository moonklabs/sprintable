import { z } from 'zod';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { getMyTeamMember } from '@/lib/auth-helpers';
import { apiError, ApiErrors, apiSuccess } from '@/lib/api-response';
import { handleApiError } from '@/lib/api-error';
import { requireOrgAdmin } from '@/lib/admin-check';
import { AgentRoutingRuleService, getRoutingPolicyIssues, normalizeRoutingAction } from '@/services/agent-routing-rule';
import { requireAgentOrchestration } from '@/lib/require-agent-orchestration';
import { isOssMode } from '@/lib/storage/factory';
import { notifyWorkflowChange } from '@/services/workflow-change-notifier';

const conditionsSchema = z.object({
  memo_type: z.array(z.string().trim().min(1)).optional(),
}).optional();

const actionSchema = z.object({
  auto_reply_mode: z.enum(['process_and_forward', 'process_and_report']).optional(),
  forward_to_agent_id: z.string().trim().min(1).nullable().optional(),
}).superRefine((value, ctx) => {
  const mode = value.auto_reply_mode ?? 'process_and_report';
  if (mode === 'process_and_report' && value.forward_to_agent_id) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['forward_to_agent_id'],
      message: 'forward_to_agent_id is only allowed when auto_reply_mode is process_and_forward',
    });
  }
}).optional();

function addRoutingPolicyIssues(ctx: z.RefinementCtx, input: { agent_id?: string; action?: unknown }) {
  if (input.action === undefined) return;
  for (const issue of getRoutingPolicyIssues({
    agentId: input.agent_id ?? null,
    action: normalizeRoutingAction(input.action),
  })) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['action', 'forward_to_agent_id'],
      message: issue.message,
    });
  }
}

const baseRuleSchema = z.object({
  agent_id: z.string().trim().min(1),
  persona_id: z.string().trim().min(1).nullable().optional(),
  deployment_id: z.string().trim().min(1).nullable().optional(),
  name: z.string().trim().min(1),
  priority: z.number().int().optional(),
  match_type: z.enum(['event', 'channel', 'project', 'manual', 'fallback']).optional(),
  conditions: conditionsSchema,
  action: actionSchema,
  target_runtime: z.string().trim().min(1).optional(),
  target_model: z.string().trim().min(1).nullable().optional(),
  is_enabled: z.boolean().optional(),
});

const createRuleSchema = baseRuleSchema.superRefine((value, ctx) => {
  addRoutingPolicyIssues(ctx, value);
});

const updateRuleSchema = baseRuleSchema.partial().extend({
  id: z.string().trim().min(1),
}).superRefine((value, ctx) => {
  addRoutingPolicyIssues(ctx, value);
});

const replaceRuleSchema = baseRuleSchema.extend({
  id: z.string().trim().min(1).optional(),
}).superRefine((value, ctx) => {
  addRoutingPolicyIssues(ctx, value);
});

const replaceRulesSchema = z.object({
  items: z.array(replaceRuleSchema),
});

const reorderSchema = z.object({
  items: z.array(z.object({
    id: z.string().trim().min(1),
    priority: z.number().int(),
  })).min(1),
});

const disableAllSchema = z.object({
  disable_all: z.literal(true),
});

export async function GET(request: Request) {
  if (isOssMode()) return apiError('NOT_IMPLEMENTED', 'Not available in OSS mode.', 501);

  try {
    const supabase = await createSupabaseServerClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return ApiErrors.unauthorized();

    const me = await getMyTeamMember(supabase, user);
    if (!me) return ApiErrors.forbidden();

    const gateResponse = await requireAgentOrchestration(supabase, me.org_id);
    if (gateResponse) return gateResponse;

    const service = new AgentRoutingRuleService(supabase);
    const { searchParams } = new URL(request.url);
    const id = searchParams.get('id');
    if (id) {
      const rule = await service.getRuleById(id, { orgId: me.org_id, projectId: me.project_id });
      return apiSuccess(rule);
    }

    const rules = await service.listRules({ orgId: me.org_id, projectId: me.project_id });
    return apiSuccess(rules);
  } catch (error) {
    return handleApiError(error);
  }
}

export async function POST(request: Request) {
  if (isOssMode()) return apiError('NOT_IMPLEMENTED', 'Not available in OSS mode.', 501);

  try {
    const supabase = await createSupabaseServerClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return ApiErrors.unauthorized();

    const me = await getMyTeamMember(supabase, user);
    if (!me) return ApiErrors.forbidden();
    await requireOrgAdmin(supabase, me.org_id);

    const gateResponse = await requireAgentOrchestration(supabase, me.org_id);
    if (gateResponse) return gateResponse;

    const parsed = createRuleSchema.safeParse(await request.json());
    if (!parsed.success) {
      return ApiErrors.validationFailed(parsed.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      })));
    }

    const service = new AgentRoutingRuleService(supabase);
    const rule = await service.createRule({
      orgId: me.org_id,
      projectId: me.project_id,
      actorId: me.id,
      ...parsed.data,
    });

    return apiSuccess(rule, undefined, 201);
  } catch (error) {
    return handleApiError(error);
  }
}

export async function PUT(request: Request) {
  if (isOssMode()) return apiError('NOT_IMPLEMENTED', 'Not available in OSS mode.', 501);

  try {
    const supabase = await createSupabaseServerClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return ApiErrors.unauthorized();

    const me = await getMyTeamMember(supabase, user);
    if (!me) return ApiErrors.forbidden();
    await requireOrgAdmin(supabase, me.org_id);

    const gateResponse = await requireAgentOrchestration(supabase, me.org_id);
    if (gateResponse) return gateResponse;

    const body = await request.json();
    const service = new AgentRoutingRuleService(supabase);

    if (body && typeof body === 'object' && 'items' in body) {
      const parsed = replaceRulesSchema.safeParse(body);
      if (!parsed.success) {
        return ApiErrors.validationFailed(parsed.error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })));
      }

      const rules = await service.replaceRules({
        orgId: me.org_id,
        projectId: me.project_id,
        actorId: me.id,
        items: parsed.data.items,
      });

      notifyWorkflowChange(supabase, {
        orgId: me.org_id,
        projectId: me.project_id,
        actorId: me.id,
        newRules: rules,
      }).catch((err) => console.warn('[PUT /agent-routing-rules] notifyWorkflowChange failed:', err));

      return apiSuccess(rules);
    }

    const parsed = updateRuleSchema.safeParse(body);
    if (!parsed.success) {
      return ApiErrors.validationFailed(parsed.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      })));
    }

    const rule = await service.updateRule(parsed.data.id, {
      orgId: me.org_id,
      projectId: me.project_id,
    }, {
      actorId: me.id,
      ...parsed.data,
    });

    return apiSuccess(rule);
  } catch (error) {
    return handleApiError(error);
  }
}

export async function PATCH(request: Request) {
  if (isOssMode()) return apiError('NOT_IMPLEMENTED', 'Not available in OSS mode.', 501);

  try {
    const supabase = await createSupabaseServerClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return ApiErrors.unauthorized();

    const me = await getMyTeamMember(supabase, user);
    if (!me) return ApiErrors.forbidden();
    await requireOrgAdmin(supabase, me.org_id);

    const gateResponse = await requireAgentOrchestration(supabase, me.org_id);
    if (gateResponse) return gateResponse;

    const body = await request.json();
    const service = new AgentRoutingRuleService(supabase);

    if (body && typeof body === 'object' && 'disable_all' in body) {
      const parsed = disableAllSchema.safeParse(body);
      if (!parsed.success) {
        return ApiErrors.validationFailed(parsed.error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })));
      }

      const rules = await service.disableRules({ orgId: me.org_id, projectId: me.project_id });
      return apiSuccess(rules);
    }

    const parsed = reorderSchema.safeParse(body);
    if (!parsed.success) {
      return ApiErrors.validationFailed(parsed.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      })));
    }

    const rules = await service.reorderPriorities({ orgId: me.org_id, projectId: me.project_id }, parsed.data.items);
    return apiSuccess(rules);
  } catch (error) {
    return handleApiError(error);
  }
}

export async function DELETE(request: Request) {
  if (isOssMode()) return apiError('NOT_IMPLEMENTED', 'Not available in OSS mode.', 501);

  try {
    const supabase = await createSupabaseServerClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return ApiErrors.unauthorized();

    const me = await getMyTeamMember(supabase, user);
    if (!me) return ApiErrors.forbidden();
    await requireOrgAdmin(supabase, me.org_id);

    const gateResponse = await requireAgentOrchestration(supabase, me.org_id);
    if (gateResponse) return gateResponse;

    const id = new URL(request.url).searchParams.get('id');
    if (!id) return ApiErrors.badRequest('id required');

    const service = new AgentRoutingRuleService(supabase);
    const result = await service.deleteRule(id, { orgId: me.org_id, projectId: me.project_id });
    return apiSuccess(result);
  } catch (error) {
    return handleApiError(error);
  }
}
