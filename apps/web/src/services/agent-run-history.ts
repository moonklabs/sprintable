import type { AgentRunFailureDisposition, RetryableFailureInput } from './agent-retry';
import { getFailureDisposition } from './agent-retry';
import { dateKeysToInstants } from '@/components/content/schedule-format';
import { dayKeyIn, shiftDayKey } from '@/lib/viewer-time-zone';

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


// story #4443 PR3a — a run happened at a moment; the person picks days in their own zone (the viewer's), so a day's bounds are
// that zone's midnight and last millisecond (was the runtime's local calendar — the server's UTC in a server render).
export function getDayStartIso(dateInput: string, timeZone: string) {
  return dateKeysToInstants(dateInput, dateInput, timeZone).from!;
}

export function getDayEndIso(dateInput: string, timeZone: string) {
  return dateKeysToInstants(dateInput, dateInput, timeZone).to!;
}

/** The default filter: the last DEFAULT_RUN_LOOKBACK_DAYS days up to the viewer's today — empty while the zone is unknown. */
export function getDefaultRunDateFilters(timeZone: string | null, now = new Date()) {
  if (!timeZone) return { fromDate: '', toDate: '' };
  const toDate = dayKeyIn(now.toISOString(), timeZone);
  return { fromDate: shiftDayKey(toDate, -DEFAULT_RUN_LOOKBACK_DAYS), toDate };
}
