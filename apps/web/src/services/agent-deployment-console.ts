import type { AgentDeploymentCardData } from './agent-dashboard';

export type DeploymentHealthState = 'healthy' | 'recovering' | 'attention' | 'paused' | 'deploying';
export type DeploymentRecoveryCueKey = 'hitl' | 'deploy_failed' | 'resume_deployment' | 'retrying' | 'manual_retry' | 'inspect_failure';

type DeploymentConsoleInput = Pick<AgentDeploymentCardData, 'status' | 'pending_hitl_count' | 'last_run_at' | 'latest_successful_run_at' | 'latest_failed_run'>;

export function hasActiveFailureSignal(input: DeploymentConsoleInput): boolean {
  const failure = input.latest_failed_run;
  if (!failure) return false;

  if (failure.failure_disposition === 'retry_scheduled' || failure.failure_disposition === 'retry_launched') {
    return true;
  }

  if (!input.latest_successful_run_at) return true;
  return new Date(failure.failed_at).getTime() >= new Date(input.latest_successful_run_at).getTime();
}

export function getDeploymentHealthState(input: DeploymentConsoleInput): DeploymentHealthState {
  if (input.status === 'DEPLOYING') return 'deploying';
  if (input.status === 'DEPLOY_FAILED') return 'attention';
  if (input.pending_hitl_count > 0) return 'attention';
  if (!hasActiveFailureSignal(input)) {
    return input.status === 'SUSPENDED' ? 'paused' : 'healthy';
  }

  const disposition = input.latest_failed_run?.failure_disposition;
  if (disposition === 'retry_scheduled' || disposition === 'retry_launched') {
    return 'recovering';
  }

  return 'attention';
}

export function getDeploymentRecoveryCueKeys(input: DeploymentConsoleInput): DeploymentRecoveryCueKey[] {
  const cues: DeploymentRecoveryCueKey[] = [];

  if (input.pending_hitl_count > 0) {
    cues.push('hitl');
  }

  if (input.status === 'DEPLOY_FAILED') {
    cues.push('deploy_failed');
  }

  if (input.status === 'SUSPENDED') {
    cues.push('resume_deployment');
  }

  if (!hasActiveFailureSignal(input)) {
    return cues;
  }

  const failure = input.latest_failed_run;
  if (!failure) return cues;

  if (failure.failure_disposition === 'retry_scheduled' || failure.failure_disposition === 'retry_launched') {
    cues.push('retrying');
    return cues;
  }

  if (failure.can_manual_retry) {
    cues.push('manual_retry');
    return cues;
  }

  cues.push('inspect_failure');
  return cues;
}
