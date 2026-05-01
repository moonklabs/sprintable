import { describe, expect, it } from 'vitest';
import { AgentRetryService, isRetryableRuntimeFailure, resolveFailureDisposition } from './agent-retry';

describe('agent-retry policy helpers', () => {
  it('treats timeout-style failures as retryable', () => {
    expect(isRetryableRuntimeFailure({ last_error_code: 'external_mcp_timeout', error_message: 'request timeout' })).toBe(true);
    expect(isRetryableRuntimeFailure({ last_error_code: 'unknown_failure', error_message: 'provider timed out' })).toBe(true);
  });

  it('marks configuration failures as non-retryable', () => {
    expect(isRetryableRuntimeFailure({ last_error_code: 'llm_config_missing', error_message: 'llm_config_missing' })).toBe(false);
  });

  it('derives retry scheduling vs terminal failure dispositions', () => {
    expect(resolveFailureDisposition({
      status: 'failed',
      retry_count: 1,
      max_retries: 3,
      next_retry_at: '2026-04-11T12:00:00.000Z',
      last_error_code: 'external_mcp_timeout',
      error_message: 'request timeout',
    })).toBe('retry_scheduled');

    expect(resolveFailureDisposition({
      status: 'failed',
      retry_count: 3,
      max_retries: 3,
      next_retry_at: null,
      last_error_code: 'external_mcp_timeout',
      error_message: 'request timeout',
    })).toBe('retry_exhausted');

    expect(resolveFailureDisposition({
      status: 'failed',
      retry_count: 0,
      max_retries: 3,
      next_retry_at: null,
      last_error_code: 'llm_config_missing',
      error_message: 'llm_config_missing',
    })).toBe('non_retryable');
  });

  it('marks the original run as retry launched and creates a queued child retry run', async () => {
    const state = {
      originalRun: {
        id: 'run-1',
        org_id: 'org-1',
        project_id: 'project-1',
        agent_id: 'agent-1',
        story_id: 'story-1',
        memo_id: 'memo-1',
        trigger: 'memo.assigned',
        model: 'gpt-5',
        status: 'failed',
        retry_count: 0,
        max_retries: 3,
        next_retry_at: '2026-04-11T12:00:00.000Z',
        last_error_code: 'external_mcp_timeout',
        error_message: 'request timeout',
        failure_disposition: 'retry_scheduled',
        result_summary: 'Request timed out',
      },
      insertedRun: null as Record<string, unknown> | null,
    };

    const db = {
      from(table: string) {
        if (table === 'agent_runs') {
          return {
            select() { return this; },
            eq() { return this; },
            single: async () => ({ data: state.originalRun, error: null }),
            update(payload: Record<string, unknown>) {
              state.originalRun = { ...state.originalRun, ...payload };
              return {
                eq: async () => ({ error: null }),
              };
            },
            insert(payload: Record<string, unknown>) {
              state.insertedRun = payload;
              return {
                select() { return this; },
                single: async () => ({
                  data: {
                    id: 'run-2',
                    org_id: payload.org_id,
                    project_id: payload.project_id,
                    agent_id: payload.agent_id,
                    story_id: payload.story_id,
                    memo_id: payload.memo_id,
                    model: payload.model,
                    trigger: payload.trigger,
                  },
                  error: null,
                }),
              };
            },
          };
        }

        if (table === 'webhook_configs') {
          return {
            select() { return this; },
            eq() { return this; },
            then(resolve: (value: { data: unknown[]; error: null }) => void) {
              return Promise.resolve({ data: [], error: null }).then(resolve);
            },
          };
        }

        throw new Error(`Unexpected table: ${table}`);
      },
    };

    const service = new AgentRetryService(db as never);
    const result = await service.executeRetry('run-1');

    expect(result).toEqual({ newRunId: 'run-2' });
    expect(state.originalRun).toMatchObject({
      retry_count: 1,
      next_retry_at: null,
      failure_disposition: 'retry_launched',
      result_summary: 'Retry launched from failed run',
    });
    expect(state.insertedRun).toMatchObject({
      status: 'queued',
      result_summary: 'Retry queued and waiting for runtime pickup',
      parent_run_id: 'run-1',
      retry_count: 1,
      failure_disposition: null,
    });
  });

  it('restores parent retry state when child retry run creation fails', async () => {
    const originalSnapshot = {
      id: 'run-1',
      org_id: 'org-1',
      project_id: 'project-1',
      agent_id: 'agent-1',
      story_id: 'story-1',
      memo_id: 'memo-1',
      trigger: 'memo.assigned',
      model: 'gpt-5',
      status: 'failed',
      retry_count: 0,
      max_retries: 3,
      next_retry_at: '2026-04-11T12:00:00.000Z',
      last_error_code: 'external_mcp_timeout',
      error_message: 'request timeout',
      failure_disposition: 'retry_scheduled',
      result_summary: 'Request timed out',
    };
    const state = {
      originalRun: { ...originalSnapshot },
      updates: [] as Record<string, unknown>[],
    };

    const db = {
      from(table: string) {
        if (table === 'agent_runs') {
          return {
            select() { return this; },
            eq() { return this; },
            single: async () => ({ data: state.originalRun, error: null }),
            update(payload: Record<string, unknown>) {
              state.updates.push(payload);
              state.originalRun = { ...state.originalRun, ...payload };
              return {
                eq: async () => ({ error: null }),
              };
            },
            insert() {
              return {
                select() { return this; },
                single: async () => ({ data: null, error: { message: 'insert failed' } }),
              };
            },
          };
        }

        throw new Error(`Unexpected table: ${table}`);
      },
    };

    const service = new AgentRetryService(db as never);

    await expect(service.executeRetry('run-1')).rejects.toThrow('Failed to create retry run: insert failed; parent retry state restored');
    expect(state.updates).toHaveLength(2);
    expect(state.originalRun).toMatchObject(originalSnapshot);
  });
});
