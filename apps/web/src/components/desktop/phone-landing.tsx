'use client';

// story 4714 (AC3 · AC4) — the phone app's landing: an empty area (no home flashes before the answer) that reads two things the server knows and goes
// where `decideLanding` says. The decision, its reads and the once-per-launch mark are in lib/phone-landing.ts; this is only the door.
import { useEffect, useRef } from 'react';
import { usePhoneBridge } from '@/components/providers/phone-bridge-context';
import { decideLanding, landedThisLaunch, markLanded, type Landing } from '@/lib/phone-landing';
import { landingHome, PHONE_START_PATH } from '@/lib/phone-landing-address';

/** how long a page that is not (yet) in the phone app waits for the shell's claim before it goes home: the claim is made as the app boots, so this is only a margin */
export const BRIDGE_WAIT_MS = 1500;

/** `next`: the home the proxy resolved for this person (see lib/phone-landing-address.ts) — where «nothing to open instead» goes */
export function PhoneLanding({ chatsHref, next }: { chatsHref: string; next?: string | null }) {
  const { inPhoneApp, phoneCall } = usePhoneBridge();
  const started = useRef(false);

  useEffect(() => {
    let alive = true;
    const go = (landing: Landing) => {
      if (!alive) return;
      window.location.replace(landing === 'chats' ? chatsHref : landing === 'start' ? PHONE_START_PATH : landingHome(next));
    };
    if (!inPhoneApp) {
      // not the phone app (a browser that opened this address · a claim that has not come): the usual home after a moment
      const timer = setTimeout(() => go('home'), BRIDGE_WAIT_MS);
      return () => { alive = false; clearTimeout(timer); };
    }
    if (started.current) return () => { alive = false; };
    started.current = true;
    if (landedThisLaunch()) { go('home'); return () => { alive = false; }; }
    markLanded(); // before the reads: a back press · a reload during them is the same launch — no second landing
    void decideLanding(phoneCall).catch((): Landing => 'home').then(go);
    return () => { alive = false; };
  }, [inPhoneApp, phoneCall, chatsHref, next]);

  return <div className="min-h-screen bg-background" data-testid="phone-landing" aria-busy="true" />;
}
