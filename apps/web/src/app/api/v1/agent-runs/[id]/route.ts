import { getMyTeamMember } from '@/lib/auth-helpers';
import { apiSuccess, ApiErrors } from '@/lib/api-response';
import { handleApiError } from '@/lib/api-error';
import { requireAgentOrchestration } from '@/lib/require-agent-orchestration';
import { createContinuityDebugInfo, getMemoryCompactionPolicy, type MemoryRetrievalDiagnostics } from '@/lib/agent-memory-contract';
import { isOssMode, createAgentRunRepository } from '@/lib/storage/factory';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const supabase: any = undefined;

type RouteParams = { params: Promise<{ id: string }> };

export async function GET(_request: Request, { params }: RouteParams) {
  if (isOssMode()) {
    try {
      const { id } = await params;
      const { OSS_ORG_ID, OSS_PROJECT_ID } = await import('@sprintable/storage-sqlite');
      const repo = await createAgentRunRepository();
      const run = await repo.getById(id, OSS_ORG_ID, OSS_PROJECT_ID);
      if (!run) return ApiErrors.notFound('Agent run not found');
      return apiSuccess({ ...run, agent_name: null, tool_audit_trail: [], continuity_debug: null });
    } catch (error) { return handleApiError(error); }
  }
  try {
    const { id } = await params;
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return ApiErrors.unauthorized();

    const me = await getMyTeamMember(supabase, user);
    if (!me) return ApiErrors.forbidden();

    const gateResponse = await requireAgentOrchestration(supabase, me.org_id);
    if (gateResponse) return gateResponse;

    const { data: run, error } = await supabase
      .from('agent_runs')
      .select('*')
      .eq('id', id)
      .eq('org_id', me.org_id)
      .eq('project_id', me.project_id)
      .single();

    if (error || !run) return ApiErrors.notFound('Agent run not found');

    // resolve agent name
    let agentName: string | null = null;
    if (run.agent_id) {
      const { data: agent } = await supabase
        .from('team_members')
        .select('name')
        .eq('id', run.agent_id as string)
        .single();
      agentName = (agent?.name as string) ?? null;
    }

    const { data: auditRows, error: auditError } = await supabase
      .from('agent_audit_logs')
      .select('id, run_id, session_id, event_type, severity, summary, payload, created_by, created_at')
      .eq('org_id', me.org_id)
      .eq('project_id', me.project_id)
      .eq('run_id', id)
      .order('created_at', { ascending: false })
      .limit(50);

    if (auditError) throw auditError;

    const toolAuditTrail = (auditRows ?? [])
      .filter((row) => typeof row.event_type === 'string' && row.event_type.startsWith('agent_tool.'))
      .map((row) => ({
        ...row,
        actor_name: row.created_by === run.agent_id ? agentName : null,
      }));

    let contextSnapshot: Record<string, unknown> | null = null;
    if (run.session_id) {
      const { data: session } = await supabase
        .from('agent_sessions')
        .select('context_snapshot')
        .eq('id', run.session_id as string)
        .eq('org_id', me.org_id)
        .eq('project_id', me.project_id)
        .single();
      contextSnapshot = (session?.context_snapshot as Record<string, unknown> | null) ?? null;
    }

    const continuityDebug = createContinuityDebugInfo({
      sessionId: (run.session_id as string | null) ?? null,
      contextSnapshot,
      restoredMemoryCount: typeof run.restored_memory_count === 'number' ? run.restored_memory_count : null,
      memoryRetrievalDiagnostics: (run.memory_diagnostics as MemoryRetrievalDiagnostics | null) ?? null,
    });

    return apiSuccess({
      ...run,
      agent_name: agentName,
      tool_audit_trail: toolAuditTrail,
      continuity_debug: continuityDebug,
      memory_compaction_policy: getMemoryCompactionPolicy(),
    });
  } catch (error) {
    return handleApiError(error);
  }
}
