import { z } from 'zod';
import { getMyTeamMember } from '@/lib/auth-helpers';
import { apiError, apiSuccess, ApiErrors } from '@/lib/api-response';
import { handleApiError } from '@/lib/api-error';
import { requireAgentOrchestration } from '@/lib/require-agent-orchestration';
import { isOssMode } from '@/lib/storage/factory';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const supabase: any = undefined;

const hitlStatusSchema = z.enum(['pending', 'approved', 'rejected', 'expired', 'cancelled', 'resolved']);

export async function GET(request: Request) {
  if (isOssMode()) return apiError('NOT_IMPLEMENTED', 'Not available in OSS mode.', 501);

  try {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return ApiErrors.unauthorized();

    const me = await getMyTeamMember(supabase, user);
    if (!me) return ApiErrors.forbidden();

    const gateResponse = await requireAgentOrchestration(supabase, me.org_id);
    if (gateResponse) return gateResponse;

    const url = new URL(request.url);
    const statusParam = url.searchParams.get('status');
    const parsedStatus = statusParam ? hitlStatusSchema.safeParse(statusParam) : null;
    if (parsedStatus && !parsedStatus.success) {
      return ApiErrors.badRequest('Invalid hitl status');
    }

    let query = supabase
      .from('agent_hitl_requests')
      .select('id, agent_id, session_id, run_id, request_type, title, prompt, requested_for, status, response_text, responded_by, responded_at, expires_at, metadata, created_at, updated_at')
      .eq('org_id', me.org_id)
      .eq('project_id', me.project_id)
      .eq('requested_for', me.id)
      .order('created_at', { ascending: false });

    if (parsedStatus?.success) {
      query = query.eq('status', parsedStatus.data);
    }

    const { data: requests, error } = await query;
    if (error) throw error;

    const memberIds = [...new Set((requests ?? []).flatMap((row) => [
      row.agent_id as string | null,
      row.requested_for as string | null,
      row.responded_by as string | null,
    ]).filter(Boolean) as string[])];

    let memberNameById: Record<string, string> = {};
    if (memberIds.length > 0) {
      const { data: members } = await supabase
        .from('team_members')
        .select('id, name')
        .in('id', memberIds);
      memberNameById = Object.fromEntries((members ?? []).map((member) => [member.id as string, member.name as string]));
    }

    const enriched = (requests ?? []).map((requestRow) => {
      const metadata = (requestRow.metadata && typeof requestRow.metadata === 'object')
        ? requestRow.metadata as Record<string, unknown>
        : {};

      return {
        ...requestRow,
        source_memo_id: (metadata.source_memo_id ?? metadata.memo_id ?? null) as string | null,
        hitl_memo_id: (metadata.hitl_memo_id ?? null) as string | null,
        agent_name: memberNameById[requestRow.agent_id as string] ?? null,
        requested_for_name: memberNameById[requestRow.requested_for as string] ?? null,
        responded_by_name: requestRow.responded_by
          ? (memberNameById[requestRow.responded_by as string] ?? null)
          : null,
      };
    });

    return apiSuccess(enriched);
  } catch (error) {
    return handleApiError(error);
  }
}
