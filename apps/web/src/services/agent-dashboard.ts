
import type { SupabaseClient } from '@/types/supabase';
import type { AgentRunFailureDisposition } from './agent-retry';
import { canManuallyRetryRun, getRunFailureDisposition } from './agent-run-history';

export interface DeploymentFailureSignal {
  run_id: string;
  memo_id: string | null;
  failed_at: string;
  error_message: string | null;
  last_error_code: string | null;
  result_summary: string | null;
  failure_disposition: AgentRunFailureDisposition | null;
  next_retry_at: string | null;
  can_manual_retry: boolean;
}

export interface AgentDeploymentCardData {
  id: string;
  name: string;
  status: string;
  model: string | null;
  runtime: string;
  agent_name: string;
  persona_name: string | null;
  updated_at: string;
  last_run_at: string | null;
  latest_successful_run_at: string | null;
  executions_today: number;
  tokens_today: number;
  pending_hitl_count: number;
  next_hitl_deadline_at: string | null;
  latest_failed_run: DeploymentFailureSignal | null;
}

export async function buildDeploymentCards(
  db: SupabaseClient,
  orgId: string,
  projectId: string,
  requestedForTeamMemberId?: string,
): Promise<AgentDeploymentCardData[]> {
  const { data: deployments, error: deploymentsError } = await db
    .from('agent_deployments')
    .select('id, name, status, model, runtime, updated_at, agent_id, persona_id')
    .eq('org_id', orgId)
    .eq('project_id', projectId)
    .is('deleted_at', null)
    .in('status', ['DEPLOYING', 'ACTIVE', 'SUSPENDED', 'DEPLOY_FAILED'])
    .order('updated_at', { ascending: false });

  if (deploymentsError) throw deploymentsError;
  if (!deployments?.length) return [];

  const agentIds = [...new Set(deployments.map((d) => d.agent_id as string).filter(Boolean))];
  const personaIds = [...new Set(deployments.map((d) => d.persona_id as string | null).filter(Boolean) as string[])];
  const deploymentIds = deployments.map((d) => d.id as string);

  // Start of today in UTC
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const todayISO = todayStart.toISOString();

  const pendingHitlRequestsQuery = db
    .from('agent_hitl_requests')
    .select('run_id, expires_at')
    .eq('org_id', orgId)
    .eq('project_id', projectId)
    .eq('status', 'pending');

  if (requestedForTeamMemberId) {
    pendingHitlRequestsQuery.eq('requested_for', requestedForTeamMemberId);
  }

  const [
    { data: agents, error: agentsError },
    { data: personas, error: personasError },
    { data: runsToday, error: runsTodayError },
    { data: latestRuns, error: latestRunsError },
    { data: latestSuccessfulRuns, error: latestSuccessfulRunsError },
    { data: latestFailedRuns, error: latestFailedRunsError },
    { data: pendingHitlRequests, error: pendingHitlRequestsError },
  ] = await Promise.all([
    agentIds.length
      ? db.from('team_members').select('id, name').in('id', agentIds)
      : Promise.resolve({ data: [] as Array<{ id: string; name: string }>, error: null }),
    personaIds.length
      ? db.from('agent_personas').select('id, name').in('id', personaIds)
      : Promise.resolve({ data: [] as Array<{ id: string; name: string }>, error: null }),
    db
      .from('agent_runs')
      .select('deployment_id, input_tokens, output_tokens')
      .in('deployment_id', deploymentIds)
      .gte('created_at', todayISO),
    db
      .from('agent_runs')
      .select('deployment_id, finished_at, started_at, created_at')
      .in('deployment_id', deploymentIds)
      .order('created_at', { ascending: false }),
    db
      .from('agent_runs')
      .select('deployment_id, finished_at, started_at, created_at')
      .in('deployment_id', deploymentIds)
      .eq('status', 'completed')
      .order('created_at', { ascending: false }),
    db
      .from('agent_runs')
      .select('id, deployment_id, memo_id, error_message, last_error_code, result_summary, retry_count, max_retries, next_retry_at, failure_disposition, finished_at, started_at, created_at')
      .in('deployment_id', deploymentIds)
      .eq('status', 'failed')
      .order('created_at', { ascending: false }),
    pendingHitlRequestsQuery,
  ]);

  if (agentsError) throw agentsError;
  if (personasError) throw personasError;
  if (runsTodayError) throw runsTodayError;
  if (latestRunsError) throw latestRunsError;
  if (latestSuccessfulRunsError) throw latestSuccessfulRunsError;
  if (latestFailedRunsError) throw latestFailedRunsError;
  if (pendingHitlRequestsError) throw pendingHitlRequestsError;

  const hitlRunIds = [...new Set((pendingHitlRequests ?? []).map((row) => row.run_id as string | null).filter(Boolean) as string[])];
  const { data: hitlRuns, error: hitlRunsError } = hitlRunIds.length
    ? await db.from('agent_runs').select('id, deployment_id').in('id', hitlRunIds)
    : { data: [] as Array<{ id: string; deployment_id: string | null }>, error: null };

  if (hitlRunsError) throw hitlRunsError;

  const agentNameById = Object.fromEntries((agents ?? []).map((a) => [a.id as string, a.name as string]));
  const personaNameById = Object.fromEntries((personas ?? []).map((p) => [p.id as string, p.name as string]));

  // Aggregate runs per deployment
  const execCountByDep: Record<string, number> = {};
  const tokensByDep: Record<string, number> = {};
  for (const run of runsToday ?? []) {
    const depId = run.deployment_id as string;
    execCountByDep[depId] = (execCountByDep[depId] ?? 0) + 1;

    const inputTokens = typeof run.input_tokens === 'number' ? run.input_tokens : 0;
    const outputTokens = typeof run.output_tokens === 'number' ? run.output_tokens : 0;
    tokensByDep[depId] = (tokensByDep[depId] ?? 0) + inputTokens + outputTokens;
  }

  const lastRunByDep: Record<string, string | null> = {};
  for (const run of latestRuns ?? []) {
    const depId = run.deployment_id as string;
    if (lastRunByDep[depId] !== undefined) continue;
    lastRunByDep[depId] = (run.finished_at as string | null) ?? (run.started_at as string | null) ?? (run.created_at as string);
  }

  const latestSuccessfulRunByDep: Record<string, string | null> = {};
  for (const run of latestSuccessfulRuns ?? []) {
    const depId = run.deployment_id as string;
    if (latestSuccessfulRunByDep[depId] !== undefined) continue;
    latestSuccessfulRunByDep[depId] = (run.finished_at as string | null) ?? (run.started_at as string | null) ?? (run.created_at as string);
  }

  const latestFailedRunByDep: Record<string, DeploymentFailureSignal> = {};
  for (const run of latestFailedRuns ?? []) {
    const depId = run.deployment_id as string;
    if (!depId || latestFailedRunByDep[depId]) continue;

    const failureDisposition = getRunFailureDisposition({
      status: 'failed',
      retry_count: typeof run.retry_count === 'number' ? run.retry_count : null,
      max_retries: typeof run.max_retries === 'number' ? run.max_retries : null,
      next_retry_at: (run.next_retry_at as string | null) ?? null,
      last_error_code: (run.last_error_code as string | null) ?? null,
      error_message: (run.error_message as string | null) ?? null,
      failure_disposition: (run.failure_disposition as AgentRunFailureDisposition | null) ?? null,
    });

    latestFailedRunByDep[depId] = {
      run_id: run.id as string,
      memo_id: (run.memo_id as string | null) ?? null,
      failed_at: (run.finished_at as string | null) ?? (run.started_at as string | null) ?? (run.created_at as string),
      error_message: (run.error_message as string | null) ?? null,
      last_error_code: (run.last_error_code as string | null) ?? null,
      result_summary: (run.result_summary as string | null) ?? null,
      failure_disposition: failureDisposition,
      next_retry_at: (run.next_retry_at as string | null) ?? null,
      can_manual_retry: canManuallyRetryRun({
        status: 'failed',
        retry_count: typeof run.retry_count === 'number' ? run.retry_count : null,
        max_retries: typeof run.max_retries === 'number' ? run.max_retries : null,
        next_retry_at: (run.next_retry_at as string | null) ?? null,
        last_error_code: (run.last_error_code as string | null) ?? null,
        error_message: (run.error_message as string | null) ?? null,
        failure_disposition: failureDisposition,
      }),
    };
  }

  const deploymentIdByRunId = Object.fromEntries((hitlRuns ?? []).map((row) => [row.id as string, row.deployment_id as string | null]));
  const pendingHitlCountByDep: Record<string, number> = {};
  const nextHitlDeadlineByDep: Record<string, string | null> = {};
  for (const request of pendingHitlRequests ?? []) {
    const depId = deploymentIdByRunId[request.run_id as string] ?? null;
    if (!depId) continue;
    pendingHitlCountByDep[depId] = (pendingHitlCountByDep[depId] ?? 0) + 1;

    const deadline = (request.expires_at as string | null) ?? null;
    if (!deadline) continue;
    const current = nextHitlDeadlineByDep[depId];
    if (!current || new Date(deadline).getTime() < new Date(current).getTime()) {
      nextHitlDeadlineByDep[depId] = deadline;
    }
  }

  return deployments.map((d) => ({
    id: d.id as string,
    name: d.name as string,
    status: d.status as string,
    model: (d.model as string | null) ?? null,
    runtime: d.runtime as string,
    agent_name: agentNameById[d.agent_id as string] ?? 'Agent',
    persona_name: d.persona_id ? personaNameById[d.persona_id as string] ?? null : null,
    updated_at: d.updated_at as string,
    last_run_at: lastRunByDep[d.id as string] ?? null,
    latest_successful_run_at: latestSuccessfulRunByDep[d.id as string] ?? null,
    executions_today: execCountByDep[d.id as string] ?? 0,
    tokens_today: tokensByDep[d.id as string] ?? 0,
    pending_hitl_count: pendingHitlCountByDep[d.id as string] ?? 0,
    next_hitl_deadline_at: nextHitlDeadlineByDep[d.id as string] ?? null,
    latest_failed_run: latestFailedRunByDep[d.id as string] ?? null,
  }));
}
