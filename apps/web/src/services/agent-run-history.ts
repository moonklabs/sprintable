import type { AgentRunFailureDisposition, RetryableFailureInput } from './agent-retry';
import { getFailureDisposition } from './agent-retry';

export const DEFAULT_RUN_STATUS_FILTER = 'completed';
export const ALL_RUN_STATUS_FILTER = 'all';
export const DEFAULT_RUN_LOOKBACK_DAYS = 7;

export function normalizeRunStatusFilter(status: string | null | undefined): string | null {
  if (!status) return DEFAULT_RUN_STATUS_FILTER;
  if (status === ALL_RUN_STATUS_FILTER) return null;
  return status;
}

export function getTriggerMemoHref(memoId: string): string {
  return `/memos?id=${memoId}`;
}

export function getRunErrorDisplay(errorMessage: string | null | undefined, lastErrorCode: string | null | undefined) {
  return {
    message: errorMessage ?? lastErrorCode ?? null,
    code: errorMessage ? (lastErrorCode ?? null) : null,
  };
}

export function getRunFailureDisposition(input: RetryableFailureInput & { failure_disposition?: AgentRunFailureDisposition | null }) {
  return getFailureDisposition(input);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

export function getToolAuditOutcome(input: { eventType?: string | null; payload?: unknown }): 'allowed' | 'denied' | 'failed' {
  const payload = asRecord(input.payload);
  const outcome = typeof payload?.outcome === 'string' ? payload.outcome : null;
  if (outcome === 'allowed' || outcome === 'denied' || outcome === 'failed') return outcome;

  const eventType = input.eventType ?? '';
  if (eventType === 'agent_tool.acl_denied' || eventType === 'agent_tool.cross_scope_blocked') return 'denied';
  if (eventType === 'agent_tool.ambiguous_external_mapping') return 'failed';
  if (eventType.endsWith('.failed')) return 'failed';
  if (eventType.endsWith('.executed')) return 'allowed';
  if (eventType.startsWith('agent_tool.')) return 'failed';

  return 'failed';
}

export function canManuallyRetryRun(input: RetryableFailureInput & { failure_disposition?: AgentRunFailureDisposition | null }) {
  const disposition = getRunFailureDisposition(input);
  return input.status === 'failed' && disposition !== 'retry_scheduled' && disposition !== 'retry_launched' && disposition !== 'non_retryable';
}

function parseLocalDateInput(dateInput: string) {
  const [year, month, day] = dateInput.split('-').map(Number);
  return { year, month, day };
}

export function getLocalDayStartIso(dateInput: string) {
  const { year, month, day } = parseLocalDateInput(dateInput);
  return new Date(year, month - 1, day, 0, 0, 0, 0).toISOString();
}

export function getLocalDayEndIso(dateInput: string) {
  const { year, month, day } = parseLocalDateInput(dateInput);
  return new Date(year, month - 1, day, 23, 59, 59, 999).toISOString();
}

function toLocalDateInputValue(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function getDefaultRunDateFilters(now = new Date()) {
  const to = new Date(now);
  const from = new Date(now);
  from.setDate(from.getDate() - DEFAULT_RUN_LOOKBACK_DAYS);

  return {
    fromDate: toLocalDateInputValue(from),
    toDate: toLocalDateInputValue(to),
  };
}
