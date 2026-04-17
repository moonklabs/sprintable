'use client';

import { useState, useCallback } from 'react';
import { readApiClientError } from '@/lib/api-client-error';

/**
 * AC4: API 403 + UPGRADE_REQUIRED 감지 → UpgradeModal 표시
 */
export function useUpgradeGuard() {
  const [showModal, setShowModal] = useState(false);
  const [meterType, setMeterType] = useState('');

  const guardedFetch = useCallback(async (input: RequestInfo | URL, init?: RequestInit) => {
    const res = await fetch(input, init);

    if (res.status === 403) {
      try {
        const payload = await readApiClientError(res.clone(), `Request failed (${res.status})`);
        if (payload.code === 'UPGRADE_REQUIRED') {
          setMeterType(payload.meterType ?? '');
          setShowModal(true);
        }
      } catch {
        // not JSON
      }
    }

    return res;
  }, []);

  const closeModal = useCallback(() => setShowModal(false), []);

  const triggerUpgrade = useCallback((meter: string) => {
    setMeterType(meter);
    setShowModal(true);
  }, []);

  return { guardedFetch, showModal, meterType, closeModal, triggerUpgrade };
}
