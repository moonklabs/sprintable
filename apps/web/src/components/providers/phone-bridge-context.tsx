'use client';

import { createContext, useContext } from 'react';

// story #4661 — the phone bridge is imported in one place (phone-bridge-claim.tsx). Every screen reads the phone state and
// the call through this context, so two copies of the bridge module can never disagree about who holds the handle.
type Answer = { id: string; ok: boolean; code?: string; [field: string]: unknown };

export interface PhoneBridgeValue {
  inPhoneApp: boolean;
  phoneCall: (type: string, args?: Record<string, unknown>) => Promise<Answer>;
}

const notInPhoneApp = async (): Promise<Answer> => ({ id: '', ok: false, code: 'not_phone_app' });

/** outside the claim (a test, a page without the root layout) the screens see «not in the phone app» */
export const PhoneBridgeContext = createContext<PhoneBridgeValue>({ inPhoneApp: false, phoneCall: notInPhoneApp });

export function usePhoneBridge(): PhoneBridgeValue {
  return useContext(PhoneBridgeContext);
}
