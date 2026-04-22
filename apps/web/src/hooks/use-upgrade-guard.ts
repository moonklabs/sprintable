'use client';

import { useCallback } from 'react';
import { readApiClientError } from '@/lib/api-client-error';
import { dispatchQuotaExceeded } from '@/components/upgrade-modal';

/**
 * Wraps fetch calls and detects 402 quota_exceeded / 403 UPGRADE_REQUIRED,
 * dispatching a global 'quota-exceeded' event to trigger UpgradeModal.
 */
export function useUpgradeGuard() {
  const guardedFetch = useCallback(async (input: RequestInfo | URL, init?: RequestInit) => {
    const res = await fetch(input, init);

    if (res.status === 402 || res.status === 403) {
      try {
        const payload = await readApiClientError(res.clone(), `Request failed (${res.status})`);
        if (payload.code === 'quota_exceeded' || payload.code === 'UPGRADE_REQUIRED') {
          dispatchQuotaExceeded({
            resource: (payload.details?.['resource'] as string) ?? payload.meterType ?? 'unknown',
            current: (payload.details?.['current'] as number) ?? 0,
            limit: (payload.details?.['limit'] as number) ?? 0,
            upgradeUrl: (payload.details?.['upgradeUrl'] as string) ?? '/upgrade',
          });
        }
      } catch {
        // not JSON — ignore
      }
    }

    return res;
  }, []);

  // Legacy compat: meetings page calls triggerUpgrade manually
  const triggerUpgrade = useCallback((meter: string) => {
    dispatchQuotaExceeded({ resource: meter, current: 0, limit: 0 });
  }, []);

  return { guardedFetch, triggerUpgrade };
}
