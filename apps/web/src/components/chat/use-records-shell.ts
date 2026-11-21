'use client';

import { useEffect, useRef, useState } from 'react';
import { usePhoneBridge } from '@/components/providers/phone-bridge-context';
import { shellTakesRecords } from '@/lib/phone-records';

/**
 * story 4977 (B3-3): does THIS phone shell open records (`shell.caps` says `records: 1`)? Asked once per `enabled` turn-on, only in the phone app and only where an entry could stand — a browser never asks the shell.
 * Turning `enabled` off (or leaving the app) forgets the answer: what comes back is asked again.
 */
export function useRecordsShell(enabled: boolean): boolean {
  const { inPhoneApp, phoneCall } = usePhoneBridge();
  const [shell, setShell] = useState(false);
  const callRef = useRef(phoneCall); // the bridge wrapper is new at every render: the read must not run again for each of them
  useEffect(() => { callRef.current = phoneCall; });
  const on = enabled && inPhoneApp;
  useEffect(() => {
    if (!on) return undefined;
    let live = true;
    void shellTakesRecords((type, args) => callRef.current(type, args)).then((ok) => { if (live) setShell(ok); });
    return () => { live = false; setShell(false); };
  }, [on]);
  return on && shell;
}
