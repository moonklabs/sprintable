import { describe, expect, it } from 'vitest';
import {
  ALL_RUN_STATUS_FILTER,
  DEFAULT_RUN_STATUS_FILTER,
  getDefaultRunDateFilters,
  getDayEndIso,
  getDayStartIso,
  getRunErrorDisplay,
  getRunFailureDisposition,
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

  // story #4443 PR3a — the viewer's days, named (was the runtime's local calendar)
  it('returns the default date filter in the viewer\'s days · empty while the zone is unknown', () => {
    expect(getDefaultRunDateFilters('Asia/Seoul', new Date('2026-04-07T12:00:00+09:00'))).toEqual({ fromDate: '2026-03-31', toDate: '2026-04-07' });
    // 2026-04-06T22:00Z is still the 6th in UTC, already the 7th in Seoul
    expect(getDefaultRunDateFilters('Asia/Seoul', new Date('2026-04-06T22:00:00Z')).toDate).toBe('2026-04-07');
    expect(getDefaultRunDateFilters('UTC', new Date('2026-04-06T22:00:00Z')).toDate).toBe('2026-04-06');
    expect(getDefaultRunDateFilters(null)).toEqual({ fromDate: '', toDate: '' });
  });

  it('builds the start/end of a day in the viewer\'s zone', () => {
    expect(getDayStartIso('2026-04-07', 'Asia/Seoul')).toBe('2026-04-06T15:00:00.000Z');
    expect(getDayEndIso('2026-04-07', 'Asia/Seoul')).toBe('2026-04-07T14:59:59.999Z');
    expect(getDayStartIso('2026-04-07', 'UTC')).toBe('2026-04-07T00:00:00.000Z');
  });
});
