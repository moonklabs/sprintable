import { z } from 'zod';
import { getMyTeamMember } from '@/lib/auth-helpers';
import { requireOrgAdmin } from '@/lib/admin-check';
import { apiError, apiSuccess, ApiErrors } from '@/lib/api-response';
import { handleApiError } from '@/lib/api-error';
import { requireAgentOrchestration } from '@/lib/require-agent-orchestration';
import { isOssMode } from '@/lib/storage/factory';
import {
  AgentHitlPolicyService,
  HITL_APPROVAL_RULE_KEYS,
  HITL_REQUEST_TYPES,
  HITL_TIMEOUT_CLASS_KEYS,
  HITL_ESCALATION_MODES,
} from '@/services/agent-hitl-policy';

const patchHitlPolicySchema = z.object({
  approval_rules: z.array(z.object({
    key: z.enum(HITL_APPROVAL_RULE_KEYS),
    request_type: z.enum(HITL_REQUEST_TYPES),
    timeout_class: z.enum(HITL_TIMEOUT_CLASS_KEYS),
    approval_required: z.literal(true).default(true),
  }).strict()),
  timeout_classes: z.array(z.object({
    key: z.enum(HITL_TIMEOUT_CLASS_KEYS),
    duration_minutes: z.number().int().min(15).max(7 * 24 * 60),
    reminder_minutes_before: z.number().int().min(5).max(24 * 60),
    escalation_mode: z.enum(HITL_ESCALATION_MODES),
  }).superRefine((value, ctx) => {
    if (value.reminder_minutes_before >= value.duration_minutes) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['reminder_minutes_before'],
        message: 'reminder must be earlier than timeout',
      });
    }
  }).strict()),
}).strict();

export async function GET() {
  if (isOssMode()) return apiError('NOT_IMPLEMENTED', 'Not available in OSS mode.', 501);

  try {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return ApiErrors.unauthorized();

    const me = await getMyTeamMember(supabase, user);
    if (!me) return ApiErrors.forbidden();
    await requireOrgAdmin(supabase, me.org_id);

    const gateResponse = await requireAgentOrchestration(supabase, me.org_id);
    if (gateResponse) return gateResponse;

    const service = new AgentHitlPolicyService(supabase as never);
    const policy = await service.getProjectPolicy({ orgId: me.org_id, projectId: me.project_id });
    return apiSuccess(policy);
  } catch (error) {
    return handleApiError(error);
  }
}

export async function PATCH(request: Request) {
  if (isOssMode()) return apiError('NOT_IMPLEMENTED', 'Not available in OSS mode.', 501);

  try {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return ApiErrors.unauthorized();

    const me = await getMyTeamMember(supabase, user);
    if (!me) return ApiErrors.forbidden();
    await requireOrgAdmin(supabase, me.org_id);

    const gateResponse = await requireAgentOrchestration(supabase, me.org_id);
    if (gateResponse) return gateResponse;

    const parsed = patchHitlPolicySchema.safeParse(await request.json());
    if (!parsed.success) {
      return ApiErrors.badRequest(parsed.error.issues.map((issue) => issue.message).join(', '));
    }

    const service = new AgentHitlPolicyService(supabase as never);
    const policy = await service.saveProjectPolicy({
      orgId: me.org_id,
      projectId: me.project_id,
      actorId: me.id,
    }, parsed.data);

    return apiSuccess(policy);
  } catch (error) {
    return handleApiError(error);
  }
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const supabase: any = undefined;
