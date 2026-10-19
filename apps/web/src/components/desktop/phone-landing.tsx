'use client';

// story 4714 (AC3 · AC4) — the phone app's landing: an empty area (no home flashes before the answer) that reads what the server says and goes where
// `decideLanding` says. The decision, its read and the once-per-launch mark are in lib/phone-landing.ts; this is only the door.
import { useEffect, useRef, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { usePhoneBridge } from '@/components/providers/phone-bridge-context';
import { decideLanding, landedThisLaunch, markLanded, type Landing } from '@/lib/phone-landing';
import { landingHome, PHONE_START_PATH } from '@/lib/phone-landing-address';

/** how long a page that is not (yet) in the phone app waits for the shell's claim before it goes home: the claim is made as the app boots, so this is only a margin */
export const BRIDGE_WAIT_MS = 1500;
/** the longest the empty area stays: a read that has not answered by then is the usual home (a bridge call can wait minutes · a person must not look at nothing) */
export const LANDING_MAX_MS = 4000;
/** the area stays EMPTY this long (a quick answer must not flash a spinner); after it a small spinner says the app is working — «loading», not a blank */
export const SPINNER_AFTER_MS = 1000;

/** `next`: the home the proxy resolved for this person (see lib/phone-landing-address.ts) — where «nothing to open instead» goes */
export function PhoneLanding({ chatsHref, next }: { chatsHref: string; next?: string | null }) {
  const t = useTranslations('common');
  const { inPhoneApp, phoneCall } = usePhoneBridge();
  const [slow, setSlow] = useState(false);
  const mounted = useRef(false); // a late answer after the page is gone moves nothing (a refs-based flag survives a strict-mode remount)
  const latest = useRef({ chatsHref, next, phoneCall });
  const started = useRef(false);
  const finished = useRef(false); // one move: the first of the answer · the limit
  const limit = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; if (limit.current) clearTimeout(limit.current); };
  }, []);
  useEffect(() => { latest.current = { chatsHref, next, phoneCall }; });
  useEffect(() => {
    const timer = setTimeout(() => setSlow(true), SPINNER_AFTER_MS);
    return () => clearTimeout(timer);
  }, []);

  useEffect(() => {
    const go = (landing: Landing) => {
      if (finished.current || !mounted.current) return;
      finished.current = true;
      if (limit.current) clearTimeout(limit.current);
      const { chatsHref: chats, next: home } = latest.current;
      window.location.replace(landing === 'chats' ? chats : landing === 'start' ? PHONE_START_PATH : landingHome(home));
    };
    if (!inPhoneApp) {
      // not the phone app (a browser that opened this address · a claim that has not come): the usual home after a moment
      const timer = setTimeout(() => go('home'), BRIDGE_WAIT_MS);
      return () => clearTimeout(timer);
    }
    if (started.current) return undefined;
    started.current = true;
    // the mark is made BEFORE the read: a back press · a reload during it is the same launch — no second landing; a storage that refuses the mark cannot keep «once»
    if (landedThisLaunch() || !markLanded()) { go('home'); return undefined; }
    limit.current = setTimeout(() => go('home'), LANDING_MAX_MS);
    void decideLanding(latest.current.phoneCall).catch((): Landing => 'home').then(go);
    return undefined;
  }, [inPhoneApp]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-background" data-testid="phone-landing" aria-busy="true">
      {slow ? <Loader2 className="size-5 animate-spin text-muted-foreground" role="status" aria-label={t('loading')} data-testid="phone-landing-spinner" /> : null}
    </div>
  );
}
