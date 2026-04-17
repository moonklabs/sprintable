import { describe, expect, it } from 'vitest';
import {
  ALL_RUN_STATUS_FILTER,
  DEFAULT_RUN_STATUS_FILTER,
  canManuallyRetryRun,
  getDefaultRunDateFilters,
  getLocalDayEndIso,
  getLocalDayStartIso,
  getRunErrorDisplay,
  getRunFailureDisposition,
  getToolAuditOutcome,
  getTriggerMemoHref,
  normalizeRunStatusFilter,
} from './agent-run-history';

describe('agent-run-history helpers', () => {
  it('defaults the status filter to completed when omitted', () => {
    expect(normalizeRunStatusFilter(undefined)).toBe(DEFAULT_RUN_STATUS_FILTER);
    expect(normalizeRunStatusFilter(null)).toBe(DEFAULT_RUN_STATUS_FILTER);
    expect(normalizeRunStatusFilter('')).toBe(DEFAULT_RUN_STATUS_FILTER);
  });

  it('allows the all sentinel to bypass status filtering', () => {
    expect(normalizeRunStatusFilter(ALL_RUN_STATUS_FILTER)).toBeNull();
    expect(normalizeRunStatusFilter('failed')).toBe('failed');
  });

  it('builds the trigger memo deep link', () => {
    expect(getTriggerMemoHref('memo-123')).toBe('/memos?id=memo-123');
  });

  it('prefers error_message over last_error_code in failed run displays', () => {
    expect(getRunErrorDisplay('Human readable failure', 'internal_code')).toEqual({
      message: 'Human readable failure',
      code: 'internal_code',
    });
    expect(getRunErrorDisplay(null, 'internal_code')).toEqual({
      message: 'internal_code',
      code: null,
    });
  });

  it('derives retry disposition for failed runs', () => {
    expect(getRunFailureDisposition({
      status: 'failed',
      retry_count: 1,
      max_retries: 3,
      next_retry_at: '2026-04-11T12:00:00.000Z',
      last_error_code: 'external_mcp_timeout',
      error_message: 'request timeout',
    })).toBe('retry_scheduled');
    expect(getRunFailureDisposition({
      status: 'failed',
      retry_count: 1,
      max_retries: 3,
      next_retry_at: null,
      last_error_code: 'external_mcp_timeout',
      error_message: 'request timeout',
      failure_disposition: 'retry_launched',
    })).toBe('retry_launched');
    expect(getRunFailureDisposition({
      status: 'failed',
      retry_count: 0,
      max_retries: 3,
      next_retry_at: null,
      last_error_code: 'llm_config_missing',
      error_message: 'llm_config_missing',
    })).toBe('non_retryable');
  });

  it('allows manual retry only for retryable failed runs that are not already in flight', () => {
    expect(canManuallyRetryRun({
      status: 'failed',
      retry_count: 3,
      max_retries: 3,
      next_retry_at: null,
      last_error_code: 'external_mcp_timeout',
      error_message: 'request timeout',
      failure_disposition: 'retry_exhausted',
    })).toBe(true);
    expect(canManuallyRetryRun({
      status: 'failed',
      retry_count: 1,
      max_retries: 3,
      next_retry_at: null,
      last_error_code: 'external_mcp_timeout',
      error_message: 'request timeout',
      failure_disposition: 'retry_launched',
    })).toBe(false);
    expect(canManuallyRetryRun({
      status: 'failed',
      retry_count: 0,
      max_retries: 3,
      next_retry_at: null,
      last_error_code: 'billing_daily_cap_exceeded',
      error_message: 'daily cap exceeded',
      failure_disposition: 'non_retryable',
    })).toBe(false);
  });

  it('fails closed for tool audit events without an explicit outcome payload', () => {
    expect(getToolAuditOutcome({
      eventType: 'agent_tool.cross_scope_blocked',
      payload: { tool_name: 'epic_scope_check' },
    })).toBe('denied');
    expect(getToolAuditOutcome({
      eventType: 'agent_tool.ambiguous_external_mapping',
      payload: { tool_name: 'external.search_docs' },
    })).toBe('failed');
    expect(getToolAuditOutcome({
      eventType: 'agent_tool.some_future_block',
      payload: { tool_name: 'future_tool' },
    })).toBe('failed');
    expect(getToolAuditOutcome({
      eventType: 'agent_tool.executed',
      payload: { tool_name: 'create_memo' },
    })).toBe('allowed');
  });

  it('returns locale-safe default date filter inputs', () => {
    expect(getDefaultRunDateFilters(new Date('2026-04-07T12:00:00+09:00'))).toEqual({
      fromDate: '2026-03-31',
      toDate: '2026-04-07',
    });
  });

  it('builds local start/end-of-day ISO bounds from date input', () => {
    expect(getLocalDayStartIso('2026-04-07')).toBe(new Date(2026, 3, 7, 0, 0, 0, 0).toISOString());
    expect(getLocalDayEndIso('2026-04-07')).toBe(new Date(2026, 3, 7, 23, 59, 59, 999).toISOString());
  });
});
