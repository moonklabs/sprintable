import { describe, expect, it } from 'vitest';
import { getDeploymentHealthState, getDeploymentRecoveryCueKeys, hasActiveFailureSignal } from './agent-deployment-console';

describe('agent-deployment-console helpers', () => {
  it('treats retrying failures as active recovery even after a newer run is queued', () => {
    const input = {
      status: 'ACTIVE',
      pending_hitl_count: 0,
      last_run_at: '2026-04-12T06:10:00.000Z',
      latest_successful_run_at: null,
      latest_failed_run: {
        run_id: 'run-1',
        memo_id: 'memo-1',
        failed_at: '2026-04-12T06:00:00.000Z',
        error_message: 'request timeout',
        last_error_code: 'external_mcp_timeout',
        result_summary: 'Timed out during MCP execution',
        failure_disposition: 'retry_scheduled' as const,
        next_retry_at: '2026-04-12T06:15:00.000Z',
        can_manual_retry: false,
      },
    };

    expect(hasActiveFailureSignal(input)).toBe(true);
    expect(getDeploymentHealthState(input)).toBe('recovering');
    expect(getDeploymentRecoveryCueKeys(input)).toEqual(['retrying']);
  });

  it('fails closed into attention when the latest run is a failed manual-retry case', () => {
    const input = {
      status: 'ACTIVE',
      pending_hitl_count: 0,
      last_run_at: '2026-04-12T06:00:00.000Z',
      latest_successful_run_at: null,
      latest_failed_run: {
        run_id: 'run-2',
        memo_id: 'memo-2',
        failed_at: '2026-04-12T06:00:00.000Z',
        error_message: 'runtime unavailable',
        last_error_code: 'external_mcp_timeout',
        result_summary: 'Timed out during MCP execution',
        failure_disposition: 'retry_exhausted' as const,
        next_retry_at: null,
        can_manual_retry: true,
      },
    };

    expect(getDeploymentHealthState(input)).toBe('attention');
    expect(getDeploymentRecoveryCueKeys(input)).toEqual(['manual_retry']);
  });

  it('keeps manual-retry failures active when only a later queued or running run exists', () => {
    const input = {
      status: 'ACTIVE',
      pending_hitl_count: 0,
      last_run_at: '2026-04-12T06:30:00.000Z',
      latest_successful_run_at: null,
      latest_failed_run: {
        run_id: 'run-3',
        memo_id: 'memo-3',
        failed_at: '2026-04-12T06:00:00.000Z',
        error_message: 'older failure',
        last_error_code: 'older_failure',
        result_summary: 'Retry still pending',
        failure_disposition: 'retry_exhausted' as const,
        next_retry_at: null,
        can_manual_retry: true,
      },
    };

    expect(hasActiveFailureSignal(input)).toBe(true);
    expect(getDeploymentHealthState(input)).toBe('attention');
    expect(getDeploymentRecoveryCueKeys(input)).toEqual(['manual_retry']);
  });

  it('ignores stale failures once a later successful run exists', () => {
    const input = {
      status: 'ACTIVE',
      pending_hitl_count: 0,
      last_run_at: '2026-04-12T06:30:00.000Z',
      latest_successful_run_at: '2026-04-12T06:30:00.000Z',
      latest_failed_run: {
        run_id: 'run-4',
        memo_id: 'memo-4',
        failed_at: '2026-04-12T06:00:00.000Z',
        error_message: 'older failure',
        last_error_code: 'older_failure',
        result_summary: 'Recovered later',
        failure_disposition: 'retry_exhausted' as const,
        next_retry_at: null,
        can_manual_retry: false,
      },
    };

    expect(hasActiveFailureSignal(input)).toBe(false);
    expect(getDeploymentHealthState(input)).toBe('healthy');
    expect(getDeploymentRecoveryCueKeys(input)).toEqual([]);
  });

  it('combines deployment and operator recovery cues on one card', () => {
    const input = {
      status: 'SUSPENDED',
      pending_hitl_count: 2,
      last_run_at: '2026-04-12T06:00:00.000Z',
      latest_successful_run_at: null,
      latest_failed_run: null,
    };

    expect(getDeploymentHealthState(input)).toBe('attention');
    expect(getDeploymentRecoveryCueKeys(input)).toEqual(['hitl', 'resume_deployment']);
  });
});
